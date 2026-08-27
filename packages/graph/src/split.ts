import type { Prisma, PrismaClient } from "@kg/db";
import { checkConceptName } from "@kg/shared";
import { proposeConcept, type ResolverDeps } from "./resolve.js";

/** Splitting a compound moves edges and topic links, but never mastery or items. */
export interface SplitResult {
  conceptId: string;
  name: string;
  reason: string;
  /** Resolved halves, with whether the resolver reused an existing concept. */
  parts: { name: string; conceptId: string; reused: boolean }[];
  edgesRewritten: number;
  itemsRetired: number;
  masteryRowsStranded: number;
}

/** Names and senses for a compound's halves; sense is immutable, so a wrong half is permanent. */
export type PartsFor = (compound: {
  name: string;
  sense: string;
  reason: string;
  /** The blunt split, as a starting point. */
  suggested: string[];
}) => Promise<{ name: string; sense: string }[]>;

export async function splitCompoundConcept(
  prisma: PrismaClient,
  resolver: ResolverDeps,
  conceptId: string,
  partsFor?: PartsFor,
): Promise<SplitResult | null> {
  const concept = await prisma.concept.findUniqueOrThrow({ where: { id: conceptId } });
  const check = checkConceptName(concept.canonicalName);
  if (check.ok) return null;

  // A compound with no usable halves is deprecated without a successor, not guessed at.
  const suggested = (check.parts ?? []).filter((h) => checkConceptName(h).ok);
  const proposed = partsFor
    ? await partsFor({
        name: concept.canonicalName,
        sense: concept.sense,
        reason: check.reason ?? "unknown",
        suggested,
      })
    : suggested.map((name) => ({ name, sense: concept.sense }));

  // A namer that returns another compound would recreate the problem.
  const halves = proposed.filter((h) => checkConceptName(h.name).ok);

  const parts: SplitResult["parts"] = [];
  const neighbours = await neighbourIds(prisma, conceptId);
  for (const half of halves) {
    const resolved = await proposeConcept(resolver, {
      name: half.name,
      sense: half.sense,
      context: `split out of the compound concept "${concept.canonicalName}"`,
      expectedNeighborIds: neighbours,
    });
    parts.push({
      name: half.name, conceptId: resolved.conceptId, reused: resolved.outcome !== "created",
    });
  }

  const edges = await prisma.edge.findMany({
    where: { OR: [{ srcId: conceptId }, { dstId: conceptId }], retiredAt: null },
  });
  const topicLinks = await prisma.topicConcept.findMany({ where: { conceptId } });
  const states = await prisma.learnerConceptState.findMany({ where: { conceptId } });

  let edgesRewritten = 0;
  await prisma.$transaction(async (tx) => {
    for (const part of parts) {
      for (const e of edges) {
        const srcId = e.srcId === conceptId ? part.conceptId : e.srcId;
        const dstId = e.dstId === conceptId ? part.conceptId : e.dstId;
        // Both ends can resolve to the same half, and the DAG trigger rejects a self-edge.
        if (srcId === dstId) continue;
        const existing = await tx.edge.findFirst({
          where: { srcId, dstId, type: e.type, retiredAt: null },
        });
        if (existing) continue;
        await tx.edge.create({
          data: {
            srcId, dstId, type: e.type, strength: e.strength,
            failureMode: e.failureMode, confidence: e.confidence,
            provisional: e.provisional,
          },
        });
        edgesRewritten++;
      }

      for (const l of topicLinks) {
        const existing = await tx.topicConcept.findFirst({
          where: { topicId: l.topicId, conceptId: part.conceptId, relation: l.relation },
        });
        if (existing) continue;
        await tx.topicConcept.create({
          data: {
            topicId: l.topicId, conceptId: part.conceptId,
            direct: l.direct, relevance: l.relevance, relation: l.relation,
          },
        });
      }

      await tx.mergeRecord.create({
        data: {
          winnerId: part.conceptId,
          loserId: conceptId,
          rewrittenEdges: edges.map((e) => e.id) as Prisma.InputJsonValue,
          // Named for what it is: nothing was moved, and that is the point.
          movedStates: {
            masteryNotMoved: states.map((s) => ({ learnerId: s.learnerId, mastery: s.mastery })),
          } as Prisma.InputJsonValue,
          reason:
            `split "${concept.canonicalName}" (${check.reason}) into "${part.name}"; ` +
            `mastery deliberately not carried over — it was never measured against one concept`,
        },
      });
    }

    // Items written for a compound ask about both halves at once.
    const retired = await tx.assessmentItem.updateMany({
      where: { conceptId, status: { not: "retired" } },
      data: { status: "retired" },
    });

    await tx.edge.updateMany({
      where: { OR: [{ srcId: conceptId }, { dstId: conceptId }], retiredAt: null },
      data: { retiredAt: new Date(), retiredReason: "source concept split into its parts" },
    });

    await tx.concept.update({
      where: { id: conceptId },
      data: {
        deprecatedAt: new Date(),
        // The schema allows one successor; the MergeRecords carry the full split.
        supersededById: parts[0]?.conceptId ?? null,
      },
    });

    return retired;
  });

  const itemsRetired = await prisma.assessmentItem.count({
    where: { conceptId, status: "retired" },
  });

  return {
    conceptId,
    name: concept.canonicalName,
    reason: check.reason ?? "unknown",
    parts,
    edgesRewritten,
    itemsRetired,
    masteryRowsStranded: states.length,
  };
}

/** Everything adjacent, so the resolver can judge a half against the right neighbourhood. */
async function neighbourIds(prisma: PrismaClient, conceptId: string): Promise<string[]> {
  const edges = await prisma.edge.findMany({
    where: { OR: [{ srcId: conceptId }, { dstId: conceptId }], retiredAt: null },
    select: { srcId: true, dstId: true },
  });
  const ids = new Set<string>();
  for (const e of edges) {
    if (e.srcId !== conceptId) ids.add(e.srcId);
    if (e.dstId !== conceptId) ids.add(e.dstId);
  }
  return [...ids];
}
