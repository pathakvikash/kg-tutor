import { z } from "zod";
import type { PrismaClient } from "@kg/db";
import { completeJson, type LLMProvider } from "@kg/llm";

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
  rejected: { claim: string; reason: string }[];
}

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
  // Too few concepts to support a claim worth naming
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

    // On one concept the claim is just that concept; on none it is invented
    if (unique.length < 2) {
      report.rejected.push({
        claim: m.claim,
        reason: unique.length === 0 ? "named no concept that exists" : "rests on a single concept",
      });
      continue;
    }
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

function restatesAConcept(claim: string, names: string[]): boolean {
  const bare = claim.toLowerCase().replace(/^you can\s+/, "").replace(/[^a-z0-9 ]/g, " ");
  const words = bare.split(/\s+/).filter(Boolean);
  return names.some((n) => {
    const stripped = bare.split(n.toLowerCase()).join(" ").split(/\s+/).filter(Boolean);
    // Little left after removing the name means the claim was name plus verb
    return stripped.length <= 2 && words.length > stripped.length;
  });
}
