import { z } from "zod";
import { completeJson, type LLMProvider } from "@kg/llm";
import { DEFAULT_THRESHOLDS, type Thresholds } from "@kg/shared";
import type { PrismaClient } from "@kg/db";
import { consensus, normalizeKey, type ConsensusItem } from "./consensus.js";
import { proposeConcept, proposeEdge, type ResolverDeps } from "./resolve.js";

const conceptSchema = z.object({
  concepts: z
    .array(z.object({ name: z.string().min(1), sense: z.string().min(1) }))
    .max(40),
});

const prereqSchema = z.object({
  prerequisites: z
    .array(
      z.object({
        name: z.string().min(1),
        sense: z.string().min(1),
        strength: z.enum(["hard", "soft"]),
        failureMode: z.string().nullable(),
      }),
    )
    .max(12),
});

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

Respond with JSON: {"prerequisites": [{"name","sense","strength","failureMode"}]}`;

export interface ExpandOptions {
  topicName: string;
  topicDescription?: string;
  llm: LLMProvider;
  resolver: ResolverDeps;
  prisma: PrismaClient;
  thresholds?: Thresholds;
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
}

async function sample<T>(
  llm: LLMProvider,
  n: number,
  req: { system: string; user: string },
  schema: z.ZodType<T>,
): Promise<T[]> {
  // Independent samples, so temperature must be above zero or all K are identical
  // and the filter measures nothing.
  return Promise.all(
    Array.from({ length: n }, () =>
      completeJson(llm, { ...req, tier: "strong", temperature: 0.7 }, schema),
    ),
  );
}

/**
 * Shallow topic expansion: Topic → its Concepts → one level of hard prerequisites. (04)
 *
 * Deliberately shallow. This is the only expansion that blocks a learner, and it is the
 * same for everyone asking for the topic, so it caches after the first. The deep
 * backwards expansion happens later, bounded by what the learner already knows — the
 * recursion floor is the learner, not the graph.
 *
 * Every concept goes through the resolver and every edge through `proposeEdge`, so
 * expansion cannot bypass dedup, the failure-mode requirement, or acyclicity.
 */
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
    conceptSamples.map((s) => s.concepts),
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
  };

  const conceptIds = new Map<string, string>();
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
  }

  // One level of prerequisites per concept.
  for (const c of concepts) {
    const targetId = conceptIds.get(normalizeKey(c.value.name));
    if (!targetId) continue;

    const prereqSamples = await sample(
      opts.llm,
      k,
      {
        system: PREREQ_SYSTEM,
        user: `Concept: ${c.value.name}\nMeaning: ${c.value.sense}\nStudied within: ${opts.topicName}`,
      },
      prereqSchema,
    );

    const { survived, dropped } = consensus(
      prereqSamples.map((s) => s.prerequisites),
      { key: (p) => normalizeKey(p.name) },
    );
    report.prerequisitesDroppedByConsensus.push(...dropped.map((d) => d.value.name));

    for (const p of survived) {
      const best = bestVariant(p);
      const pre = await proposeConcept(opts.resolver, {
        name: best.name,
        sense: best.sense,
        context: `prerequisite of "${c.value.name}"`,
        expectedNeighborIds: [targetId, ...conceptIds.values()],
      });
      if (pre.outcome === "created") report.conceptsCreated++;
      else report.conceptsBound++;

      // Pulled in as a prerequisite, so it belongs to the topic but not directly.
      await link(opts.prisma, topic.id, pre.conceptId, false);

      if (pre.conceptId === targetId) continue; // a concept is not its own prerequisite

      const edge = await proposeEdge(opts.prisma, {
        srcId: pre.conceptId,
        dstId: targetId,
        type: "prerequisite_of",
        strength: best.strength,
        failureMode: best.failureMode,
        confidence: Math.min(0.9, p.votes / prereqSamples.length),
      });
      if (edge.rejected === "cycle") report.edgesRejectedAsCycle++;
      else if (edge.edgeId) {
        report.edgesWritten++;
        if (edge.demoted) report.edgesDemoted++;
      }
    }
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

/**
 * Samples disagree on phrasing. Prefer the variant that justifies the strongest claim:
 * a `hard` proposal with a real failure mode beats one whose failure mode is empty.
 */
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
