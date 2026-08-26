import { z } from "zod";
import type { PrismaClient } from "@kg/db";
import { completeJson, type LLMProvider } from "@kg/llm";

/**
 * Capability claims for a topic, written after its concepts exist.
 *
 * MilestoneTemplate rows were only ever produced by the seed script, so every topic a
 * learner expanded themselves had none — and `attachMilestones` reads templates, so
 * their roadmap rendered as one flat list of every concept. Data Structures came out at
 * 37. The Roadmap component groups by milestone precisely because "a flat list of
 * nineteen concepts reads as a wall", and nothing was grouping.
 *
 * A milestone is not a heading over some concepts. It is the thing the learner can do
 * once they hold them, stated so they could check it themselves — which is what makes it
 * worth finishing, and what makes "2 of 4" mean something.
 */

const milestoneSchema = z.object({
  milestones: z
    .array(
      z.object({
        claim: z.string().min(1),
        concepts: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});

const MILESTONE_SYSTEM = `You name the capabilities a learner gains from a body of knowledge.

A milestone is a CAPABILITY CLAIM — something the learner can DO once they hold a group
of concepts, phrased so they could check it about themselves:

  "you can predict the order of asynchronous output"
  "you can choose the right structure for a lookup-heavy workload"
  "you can tell why a program ran out of memory"

It is NOT a topic heading ("data structure fundamentals"), NOT a list of concepts
("arrays, lists and trees"), and NOT a restatement of a single concept ("you can use
hash tables" when "Hash Table" is one of the concepts). If a claim needs only one
concept, it is not a milestone — it is that concept.

Each milestone requires 2 to 6 concepts, copied EXACTLY from the list you are given. Do
not invent concepts and do not rename them. A concept may appear in more than one
milestone; not every concept has to appear.

Order them so a learner reaches them in sequence: the first should need only concepts
that depend on little else.

Three to six milestones for the whole topic. Fewer real capabilities beat many thin ones.

Respond with JSON: {"milestones":[{"claim","concepts":["exact name", ...]}]}`;

export interface MilestoneReport {
  written: { claim: string; concepts: string[] }[];
  /** Rejected, with why — the filter's output, not hidden. */
  rejected: { claim: string; reason: string }[];
}

/**
 * Writes capability claims for a topic. Idempotent: a topic that already has templates
 * is left alone, so re-expanding does not duplicate them.
 */
export async function generateMilestones(
  prisma: PrismaClient,
  llm: LLMProvider,
  topicId: string,
): Promise<MilestoneReport> {
  const report: MilestoneReport = { written: [], rejected: [] };

  const existing = await prisma.milestoneTemplate.count({ where: { topicId } });
  if (existing > 0) return report;

  const topic = await prisma.topic.findUniqueOrThrow({ where: { id: topicId } });
  const links = await prisma.topicConcept.findMany({
    where: { topicId, relation: "contains", concept: { deprecatedAt: null } },
    include: { concept: true },
  });
  // Two concepts cannot support a capability claim worth naming.
  if (links.length < 3) return report;

  const byName = new Map(links.map((l) => [l.concept.canonicalName.toLowerCase(), l.concept]));

  const out = await completeJson(
    llm,
    {
      system: MILESTONE_SYSTEM,
      user: [
        `Body of knowledge: ${topic.name}`,
        topic.description ? `Description: ${topic.description}` : "",
        "",
        "Concepts available (use these names exactly):",
        ...links.map((l) => `- ${l.concept.canonicalName} — ${l.concept.sense}`),
      ]
        .filter(Boolean)
        .join("\n"),
      tier: "strong",
      temperature: 0.3,
    },
    milestoneSchema,
  );

  let ordering = 0;
  for (const m of out.milestones.slice(0, 6)) {
    const matched = m.concepts
      .map((n) => byName.get(n.trim().toLowerCase()))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    const unique = [...new Map(matched.map((c) => [c.id, c])).values()];

    // A claim resting on one concept is that concept. A claim resting on none is a
    // hallucinated group, and attaching it would hand out a completion for nothing —
    // which is the malformed case `trimMilestone` already refuses to attach.
    if (unique.length < 2) {
      report.rejected.push({
        claim: m.claim,
        reason: unique.length === 0 ? "named no concept that exists" : "rests on a single concept",
      });
      continue;
    }
    // "you can use hash tables" over the concept "Hash Table" restates rather than claims.
    if (unique.length === 2 && restatesAConcept(m.claim, unique.map((c) => c.canonicalName))) {
      report.rejected.push({ claim: m.claim, reason: "restates a concept name" });
      continue;
    }

    const template = await prisma.milestoneTemplate.create({
      data: { topicId, claim: m.claim.trim(), ordering, status: "candidate" },
    });
    for (const c of unique) {
      await prisma.milestoneConcept.create({
        data: { templateId: template.id, conceptId: c.id, requiredLevel: "functional" },
      });
    }
    report.written.push({ claim: m.claim.trim(), concepts: unique.map((c) => c.canonicalName) });
    ordering++;
  }

  return report;
}

/** True when the claim is little more than one of its concept names. */
function restatesAConcept(claim: string, names: string[]): boolean {
  const bare = claim.toLowerCase().replace(/^you can\s+/, "").replace(/[^a-z0-9 ]/g, " ");
  const words = bare.split(/\s+/).filter(Boolean);
  return names.some((n) => {
    const stripped = bare.split(n.toLowerCase()).join(" ").split(/\s+/).filter(Boolean);
    // Removing the concept name leaves almost nothing: the claim was the name plus a verb.
    return stripped.length <= 2 && words.length > stripped.length;
  });
}
