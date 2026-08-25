import { z } from "zod";
import { Prisma } from "@kg/db";
import type { PrismaClient } from "@kg/db";
import { arrayOrWrapped, completeJson, type LLMProvider } from "@kg/llm";
import type { MasteryLevel } from "@kg/shared";

const itemSchema = arrayOrWrapped(
  "items",
  z.object({
    prompt: z.string().min(1),
    targetsLevel: z.enum(["familiar", "functional", "solid"]),
    requiresTransfer: z.boolean(),
    /** What a correct answer must demonstrate — not a model answer to match against. */
    mustDemonstrate: z.array(z.string()).min(1),
  }),
);

const ITEM_SYSTEM = `You write assessment items for a single learning concept.

Each item must DISCRIMINATE: a learner who understands the concept answers it correctly,
and one who does not, cannot. An item answerable by repeating a definition is worthless.

Levels:
- "familiar": can state what it is in their own words
- "functional": can apply it in a situation they have seen the shape of before
- "solid": can apply it in an unfamiliar context, or debug it when it goes wrong

Set requiresTransfer true when the item deliberately uses a context the learner's
explanation would not have covered. At least one item per concept must do this — without
transfer items, a fluent paraphrase promotes a learner who cannot use the concept.

mustDemonstrate lists what a correct answer has to show. Write it as observable claims,
not as a model answer.

Respond with JSON: {"items": [{"prompt","targetsLevel","requiresTransfer","mustDemonstrate"}]}`;

/**
 * Items are stored, versioned objects on the Concept — not regenerated per learner. (07)
 *
 * Fresh questions every session would make cross-learner statistics impossible, and
 * those statistics are the only way an item bank improves. Generated items enter as
 * candidates and earn `canonical` through use, like everything else.
 */
export async function generateItems(
  prisma: PrismaClient,
  llm: LLMProvider,
  conceptId: string,
): Promise<{ created: number }> {
  const concept = await prisma.concept.findUniqueOrThrow({ where: { id: conceptId } });
  const prereqs = await prisma.edge.findMany({
    where: { dstId: conceptId, type: "prerequisite_of", strength: "hard", retiredAt: null },
    include: { src: true },
  });

  const out = await completeJson(
    llm,
    {
      system: ITEM_SYSTEM,
      user: [
        `Concept: ${concept.canonicalName}`,
        `Meaning: ${concept.sense}`,
        prereqs.length > 0
          ? `Known failure modes to probe for:\n${prereqs
              .filter((p) => p.failureMode)
              .map((p) => `- ${p.failureMode}`)
              .join("\n")}`
          : "",
      ].filter(Boolean).join("\n"),
      tier: "strong",
      temperature: 0.4,
    },
    itemSchema,
  );

  const existing = await prisma.assessmentItem.findMany({ where: { conceptId } });
  const seen = new Set(existing.map((e) => e.prompt.trim().toLowerCase()));

  let created = 0;
  for (const item of (out.items ?? []).slice(0, 6)) {
    if (seen.has(item.prompt.trim().toLowerCase())) continue;
    await prisma.assessmentItem.create({
      data: {
        conceptId,
        prompt: item.prompt,
        rubric: { mustDemonstrate: item.mustDemonstrate } as Prisma.InputJsonValue,
        targetsLevel: item.targetsLevel as MasteryLevel,
        requiresTransfer: item.requiresTransfer,
        status: "candidate",
      },
    });
    created++;
  }
  return { created };
}

/**
 * Picks an item for the level being tested. Prefers canonical over candidate, then the
 * item that best separates learners who understand from those who do not. (07)
 */
export async function selectItem(
  prisma: PrismaClient,
  conceptId: string,
  targetsLevel: MasteryLevel,
  excludeItemIds: string[] = [],
) {
  const items = await prisma.assessmentItem.findMany({
    where: {
      conceptId,
      targetsLevel,
      status: { not: "retired" },
      ...(excludeItemIds.length > 0 ? { id: { notIn: excludeItemIds } } : {}),
    },
  });
  if (items.length === 0) return null;
  return items.sort(
    (a, b) =>
      Number(b.status === "canonical") - Number(a.status === "canonical") ||
      b.discrimination - a.discrimination ||
      a.timesUsed - b.timesUsed,
  )[0]!;
}

export interface ItemStatsUpdate {
  itemId: string;
  timesUsed: number;
  successRate: number;
  discrimination: number;
  action: "kept" | "retired" | "promoted";
}

/**
 * Item statistics are the one tier that promotes automatically: local, purely
 * statistical, and self-correcting if wrong. (11)
 *
 * Discrimination is measured against whether getting the item right predicts later
 * success on concepts that depend on this one. An item everyone passes tells you
 * nothing; an item that passing predicts nothing about tells you less.
 */
export async function updateItemStats(
  prisma: PrismaClient,
  conceptId: string,
  minUses = 30,
): Promise<ItemStatsUpdate[]> {
  const items = await prisma.assessmentItem.findMany({ where: { conceptId } });
  const dependents = await prisma.edge.findMany({
    where: { srcId: conceptId, type: "prerequisite_of", retiredAt: null },
    select: { dstId: true },
  });
  const dependentIds = dependents.map((d) => d.dstId);

  const out: ItemStatsUpdate[] = [];
  for (const item of items) {
    if (item.timesUsed < minUses) continue;
    const successRate = item.timesUsed === 0 ? 0 : item.correctCount / item.timesUsed;

    let discrimination = 0;
    if (dependentIds.length > 0) {
      const attempts = await prisma.evidenceEvent.findMany({
        where: { itemId: item.id },
        select: { learnerId: true, kind: true },
      });
      const passed = attempts.filter((a) => a.kind === "applied" || a.kind === "transferred");
      const failed = attempts.filter((a) => a.kind === "failed_check");
      const downstreamRate = async (learnerIds: string[]) => {
        if (learnerIds.length === 0) return 0;
        const wins = await prisma.evidenceEvent.count({
          where: {
            learnerId: { in: learnerIds },
            conceptId: { in: dependentIds },
            kind: { in: ["applied", "transferred"] },
          },
        });
        return wins / learnerIds.length;
      };
      discrimination =
        (await downstreamRate(passed.map((p) => p.learnerId))) -
        (await downstreamRate(failed.map((f) => f.learnerId)));
    }

    // Everyone passes or everyone fails: it separates nobody.
    const uninformative = successRate > 0.97 || successRate < 0.03;
    const antiPredictive = dependentIds.length > 0 && discrimination < -0.1;
    const action: ItemStatsUpdate["action"] =
      uninformative || antiPredictive
        ? "retired"
        : discrimination > 0.2 && item.status === "candidate"
          ? "promoted"
          : "kept";

    await prisma.assessmentItem.update({
      where: { id: item.id },
      data: {
        discrimination,
        ...(action === "retired" ? { status: "retired" as const } : {}),
        ...(action === "promoted" ? { status: "canonical" as const } : {}),
      },
    });
    out.push({ itemId: item.id, timesUsed: item.timesUsed, successRate, discrimination, action });
  }
  return out;
}

/**
 * Explanation candidates earn `canonical` the same way, but on a different signal:
 * whether the learners who saw them went on to pass. (12)
 */
export async function promoteExplanations(
  prisma: PrismaClient,
  conceptId: string,
  minShown = 30,
): Promise<{ contentId: string; passRate: number; action: "promoted" | "retired" | "kept" }[]> {
  const contents = await prisma.explanationContent.findMany({
    where: { conceptId, status: "candidate" },
  });
  const out: { contentId: string; passRate: number; action: "promoted" | "retired" | "kept" }[] = [];
  for (const c of contents) {
    if (c.timesShown < minShown) continue;
    const passRate = c.timesShown === 0 ? 0 : c.followedByPass / c.timesShown;
    const action = passRate >= 0.7 ? "promoted" : passRate < 0.3 ? "retired" : "kept";
    if (action !== "kept") {
      await prisma.explanationContent.update({
        where: { id: c.id },
        data: { status: action === "promoted" ? "canonical" : "retired" },
      });
    }
    out.push({ contentId: c.id, passRate, action });
  }
  return out;
}
