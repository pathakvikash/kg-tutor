import { z } from "zod";
import { arrayOrWrapped, completeJson, type LLMProvider } from "@kg/llm";
import { DEFAULT_THRESHOLDS, checkConceptName, type Thresholds } from "@kg/shared";
import { generateMilestones } from "./milestones.js";
import type { PrismaClient } from "@kg/db";
import { consensus, normalizeKey, type ConsensusItem } from "./consensus.js";
import { proposeConcept, proposeEdge, type ResolverDeps } from "./resolve.js";

const conceptSchema = arrayOrWrapped(
  "concepts",
  z.object({ name: z.string().min(1), sense: z.string().min(1) }),
);

const prereqSchema = arrayOrWrapped(
  "prerequisites",
  z.object({
    name: z.string().min(1),
    sense: z.string().min(1),
    strength: z.enum(["hard", "soft"]),
    failureMode: z.string().nullable(),
  }),
);

const CONCEPT_SYSTEM = `You break a learning topic into its teachable concepts.

A concept must be:
- explainable in one learning session, AND
- something you could write a question for that separates a learner who understands it
  from one who does not.

If you cannot write such a question, it is too broad — leave it out. Do not list
sub-topics, chapters, or areas of study. Do not list the topic itself.

Each concept gets a "sense": one line stating what it means, precise enough to tell it
apart from a similarly-named concept in a different field.

Respond with JSON: {"concepts": [{"name": "...", "sense": "..."}]}`;

const PREREQ_SYSTEM = `You identify the immediate prerequisites of a single learning concept.

Rules:
- Only PROXIMATE prerequisites — one step back. Do not list a prerequisite that is
  itself reached through another prerequisite you are listing.
- "hard" means the concept genuinely cannot be understood without it. "soft" means it
  helps or adds depth.
- Every "hard" prerequisite REQUIRES a failureMode: the specific wrong belief or wrong
  behaviour a learner exhibits without it. Not "they will be confused" — state what
  they actually get wrong. If you cannot name one, the prerequisite is "soft".
- Prefer few and correct over many and plausible. Three real prerequisites beat eight
  loosely-related ones.
- "name" is the NAME OF ONE CONCEPT, not a description of what the learner needs. A
  short noun phrase, at most a few words. Never join two things: "Hash Functions and
  Hash Tables" is two concepts and belongs as two entries, "Recursion or iterative
  traversal" is two, "Graph terminology (vertices, edges, weighted)" is a syllabus
  heading. Never end in "concepts", "basics", "fundamentals" or "terminology" — name the
  thing itself. Put the description in "sense", which is what it is for.

Respond with JSON: {"prerequisites": [{"name","sense","strength","failureMode"}]}`;

export interface ExpandOptions {
  topicName: string;
  topicDescription?: string;
  llm: LLMProvider;
  resolver: ResolverDeps;
  prisma: PrismaClient;
  thresholds?: Thresholds;
  /** Called as the job advances, carrying the partial report for live rendering. */
  onProgress?: (phase: string, progress: number, partial: ExpandReport) => void;
}

export interface ExpandReport {
  topicId: string;
  conceptsCreated: number;
  conceptsBound: number;
  edgesWritten: number;
  /** Hard proposals written as soft because the failure mode did not survive. (15) */
  edgesDemoted: number;
  edgesRejectedAsCycle: number;
  /** Below the consensus threshold — the measurable output of the filter. (15) */
  conceptsDroppedByConsensus: string[];
  prerequisitesDroppedByConsensus: string[];
  /** Concepts written, but whose prerequisite pass failed. Reported, not hidden. */
  conceptsWithFailedPrerequisites: string[];
  /** Names that did not denote one concept, and what was proposed instead. (04) */
  namesRejected: { name: string; reason: string; splitInto: string[] }[];
  /** Capability claims written for the topic, and any rejected. (09) */
  milestones: { claim: string; concepts: string[] }[];
  milestonesRejected: { claim: string; reason: string }[];
  /** Survivors of the consensus filter, with how many samples named each. */
  conceptsFound: { name: string; votes: number }[];
  /** An append-only activity log the UI renders live. */
  events: { kind: string; name: string; detail: string }[];
}

async function sample<T>(
  llm: LLMProvider,
  n: number,
  req: { system: string; user: string },
  schema: z.ZodType<T>,
): Promise<T[]> {
  // Temperature must stay above zero or all K samples come back identical.
  return Promise.all(
    Array.from({ length: n }, () =>
      completeJson(llm, { ...req, tier: "strong", temperature: 0.7 }, schema),
    ),
  );
}

/** Topic to concepts to one level of prerequisites, all through the resolver. (04) */
export async function expandTopicShallow(opts: ExpandOptions): Promise<ExpandReport> {
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const k = t.expansionSamples;

  const topic = await opts.prisma.topic.upsert({
    where: { name: opts.topicName },
    create: { name: opts.topicName, description: opts.topicDescription ?? "" },
    update: {},
  });

  const conceptSamples = await sample(
    opts.llm,
    k,
    {
      system: CONCEPT_SYSTEM,
      user: `Topic: ${opts.topicName}${opts.topicDescription ? `\n${opts.topicDescription}` : ""}`,
    },
    conceptSchema,
  );

  const { survived: concepts, dropped: droppedConcepts } = consensus(
    conceptSamples.map((s) => (s.concepts ?? []).slice(0, 40)),
    { key: (c) => normalizeKey(c.name) },
  );

  const report: ExpandReport = {
    topicId: topic.id,
    conceptsCreated: 0,
    conceptsBound: 0,
    edgesWritten: 0,
    edgesDemoted: 0,
    edgesRejectedAsCycle: 0,
    conceptsDroppedByConsensus: droppedConcepts.map((d) => d.value.name),
    prerequisitesDroppedByConsensus: [],
    namesRejected: [],
    milestones: [],
    milestonesRejected: [],
    conceptsWithFailedPrerequisites: [],
    conceptsFound: [],
    events: droppedConcepts.map((d) => ({
      kind: "dropped",
      name: d.value.name,
      detail: `only ${d.votes} of ${conceptSamples.length} samples proposed it`,
    })),
  };

  report.conceptsFound = concepts.map((c) => ({ name: c.value.name, votes: c.votes }));
  opts.onProgress?.(`writing ${concepts.length} concepts`, 0.25, report);

  const conceptIds = new Map<string, string>();
  let written = 0;
  for (const c of concepts) {
    const r = await proposeConcept(opts.resolver, {
      name: c.value.name,
      sense: c.value.sense,
      context: `expanding the topic "${opts.topicName}"`,
      expectedNeighborIds: [...conceptIds.values()],
    });
    conceptIds.set(normalizeKey(c.value.name), r.conceptId);
    if (r.outcome === "created") report.conceptsCreated++;
    else report.conceptsBound++;
    await link(opts.prisma, topic.id, r.conceptId, true);
    written++;
    report.events.push({
      kind: r.outcome === "created" ? "concept_created" : "concept_reused",
      name: c.value.name,
      detail: r.outcome === "created" ? c.value.sense : `bound to an existing concept`,
    });
    opts.onProgress?.(
      `writing concepts (${written}/${concepts.length})`,
      0.25 + 0.2 * (written / Math.max(1, concepts.length)),
      report,
    );
  }

  // One level of prerequisites per concept.
  let done = 0;
  for (const c of concepts) {
    opts.onProgress?.(
      `prerequisites for "${c.value.name}" (${done + 1}/${concepts.length})`,
      0.45 + 0.55 * (done / Math.max(1, concepts.length)),
      report,
    );
    done++;
    const targetId = conceptIds.get(normalizeKey(c.value.name));
    if (!targetId) continue;

    await expandPrerequisitesOf(
      { id: targetId, name: c.value.name, sense: c.value.sense },
      {
        prisma: opts.prisma,
        llm: opts.llm,
        resolver: opts.resolver,
        topicId: topic.id,
        topicName: opts.topicName,
        neighbourIds: [targetId, ...conceptIds.values()],
        samples: k,
      },
      report,
    );
    // Keep the tail bounded; the UI only shows the most recent activity anyway.
    if (report.events.length > 200) report.events.splice(0, report.events.length - 200);
  }

  // Last because a claim needs its concepts to exist; a failure here is reported, not fatal.
  try {
    const milestones = await generateMilestones(opts.prisma, opts.llm, topic.id);
    report.milestones = milestones.written;
    report.milestonesRejected = milestones.rejected;
    for (const m of milestones.written) {
      report.events.push({
        kind: "milestone_written",
        name: m.claim,
        detail: `${m.concepts.length} concepts: ${m.concepts.join(", ")}`,
      });
    }
    for (const m of milestones.rejected) {
      report.events.push({ kind: "milestone_rejected", name: m.claim, detail: m.reason });
    }
  } catch (err) {
    report.events.push({
      kind: "milestones_failed",
      name: topic.name,
      detail: `${err instanceof Error ? err.message : String(err)} — run backfill:milestones`,
    });
  }

  return report;
}

/** Idempotent: re-expanding a topic must not fail on concepts it already contains. */
async function link(
  prisma: PrismaClient,
  topicId: string,
  conceptId: string,
  direct: boolean,
): Promise<void> {
  await prisma.topicConcept.upsert({
    where: {
      topicId_conceptId_relation: { topicId, conceptId, relation: "contains" },
    },
    create: { topicId, conceptId, direct, relation: "contains" },
    // A concept that arrives as a prerequisite must not downgrade an existing direct link.
    update: direct ? { direct: true } : {},
  });
}

/** Prefer the variant justifying the strongest claim: hard with a real failure mode. */
function bestVariant<T extends { strength: "hard" | "soft"; failureMode: string | null }>(
  item: ConsensusItem<T>,
): T {
  const withFailure = item.variants.filter(
    (v) => v.strength === "hard" && v.failureMode && v.failureMode.trim().length > 0,
  );
  const longest = withFailure.sort(
    (a, b) => (b.failureMode?.length ?? 0) - (a.failureMode?.length ?? 0),
  )[0];
  return longest ?? item.value;
}

/** Extracted so deepening one concept runs the identical path a full expansion does. */
export async function expandPrerequisitesOf(
  target: { id: string; name: string; sense: string },
  ctx: {
    prisma: PrismaClient;
    llm: LLMProvider;
    resolver: ResolverDeps;
    topicId: string;
    topicName: string;
    /** Concepts the resolver should judge a candidate against. */
    neighbourIds: string[];
    samples?: number;
  },
  report: ExpandReport,
): Promise<void> {
  const { prisma, llm, resolver, topicId, topicName, neighbourIds } = ctx;
  const k = ctx.samples ?? DEFAULT_THRESHOLDS.expansionSamples;
  const targetId = target.id;
  const opts = { prisma, llm, resolver };

  let prereqSamples: Record<string, { name: string; sense: string; strength: "hard" | "soft"; failureMode: string | null }[]>[] = [];
  try {
    prereqSamples = await sample(
      opts.llm,
      k,
      {
        system: PREREQ_SYSTEM,
        user: `Concept: ${target.name}\nMeaning: ${target.sense}\nStudied within: ${topicName}`,
      },
      prereqSchema,
    );
  } catch (err) {
    // The concept is already written, so a partial result is worth keeping.
    report.conceptsWithFailedPrerequisites.push(target.name);
    return;
  }

  const { survived, dropped } = consensus(
    prereqSamples.map((s) => (s.prerequisites ?? []).slice(0, 12)),
    { key: (p) => normalizeKey(p.name) },
  );
  report.prerequisitesDroppedByConsensus.push(...dropped.map((d) => d.value.name));

  for (const p of survived) {
    const best = bestVariant(p);

    // A compound name written here is permanent, so split it when both halves are real.
    const nameCheck = checkConceptName(best.name);
    if (!nameCheck.ok) {
      const halves = (nameCheck.parts ?? []).filter((h) => checkConceptName(h).ok);
      report.namesRejected.push({
        name: best.name, reason: nameCheck.reason ?? "unknown", splitInto: halves,
      });
      report.events.push({
        kind: "name_rejected",
        name: best.name,
        detail: halves.length > 0
          ? `not one concept (${nameCheck.reason}) — proposing ${halves.join(" + ")}`
          : `not one concept (${nameCheck.reason}) — dropped`,
      });
      for (const half of halves) {
        const split = await proposeConcept(opts.resolver, {
          name: half,
          sense: best.sense,
          context: `prerequisite of "${target.name}"`,
          expectedNeighborIds: neighbourIds,
        });
        if (split.outcome === "created") report.conceptsCreated++;
        else report.conceptsBound++;
        await link(opts.prisma, topicId, split.conceptId, false);
      }
      continue;
    }

    const pre = await proposeConcept(opts.resolver, {
      name: best.name,
      sense: best.sense,
      context: `prerequisite of "${target.name}"`,
      expectedNeighborIds: neighbourIds,
    });
    if (pre.outcome === "created") report.conceptsCreated++;
    else report.conceptsBound++;

    // Pulled in as a prerequisite, so it belongs to the topic but not directly.
    await link(opts.prisma, topicId, pre.conceptId, false);

    if (pre.conceptId === targetId) continue; // a concept is not its own prerequisite

    const edge = await proposeEdge(opts.prisma, {
      srcId: pre.conceptId,
      dstId: targetId,
      type: "prerequisite_of",
      strength: best.strength,
      failureMode: best.failureMode,
      confidence: Math.min(0.9, p.votes / prereqSamples.length),
    });
    if (edge.rejected === "cycle") {
      report.edgesRejectedAsCycle++;
      report.events.push({
        kind: "edge_rejected",
        name: `${best.name} → ${target.name}`,
        detail: "would close a prerequisite cycle",
      });
    } else if (edge.edgeId) {
      report.edgesWritten++;
      if (edge.demoted) report.edgesDemoted++;
      report.events.push({
        kind: edge.demoted ? "edge_demoted" : "edge_written",
        name: `${best.name} → ${target.name}`,
        detail: edge.demoted
          ? "proposed hard, but the failure mode said nothing concrete — kept as soft"
          : (best.failureMode ?? edge.strength),
      });
    }
  }
}
