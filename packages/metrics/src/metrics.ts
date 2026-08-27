import type { PrismaClient } from "@kg/db";
import { atLeast, rank, type MasteryLevel } from "@kg/shared";

export interface Window {
  from?: Date;
  to?: Date;
}

function range(w: Window = {}) {
  return {
    ...(w.from ? { gte: w.from } : {}),
    ...(w.to ? { lte: w.to } : {}),
  };
}

export interface GraphReuse {
  proposals: number;
  bound: number;
  created: number;
  /** Fraction of proposals that resolved to a concept that already existed. */
  reuseRate: number;
}

/** The earliest and cheapest falsification signal for the shared-graph premise. (14) */
export async function graphReuseRate(prisma: PrismaClient, w: Window = {}): Promise<GraphReuse> {
  const where = { outcome: { not: null }, ...(w.from || w.to ? { createdAt: range(w) } : {}) };
  const [bound, created] = await Promise.all([
    prisma.conceptProposal.count({ where: { ...where, outcome: "bound" } }),
    prisma.conceptProposal.count({ where: { ...where, outcome: "created" } }),
  ]);
  const proposals = bound + created;
  return { proposals, bound, created, reuseRate: proposals === 0 ? 0 : bound / proposals };
}

/** Reuse broken down by topic, so a thin corner of the graph is visible. */
export async function graphReuseByTopic(
  prisma: PrismaClient,
): Promise<{ topic: string; reuseRate: number; proposals: number }[]> {
  const rows = await prisma.$queryRawUnsafe<
    { topic: string; bound: bigint; total: bigint }[]
  >(`
    SELECT t.name AS topic,
           COUNT(*) FILTER (WHERE p.outcome = 'bound') AS bound,
           COUNT(*) AS total
      FROM "ConceptProposal" p
      JOIN "TopicConcept" tc ON tc."conceptId" = p."resolvedToId"
      JOIN "Topic" t ON t.id = tc."topicId"
     WHERE p.outcome IS NOT NULL
     GROUP BY t.name
     ORDER BY total DESC
  `);
  return rows.map((r) => ({
    topic: r.topic,
    proposals: Number(r.total),
    reuseRate: Number(r.total) === 0 ? 0 : Number(r.bound) / Number(r.total),
  }));
}

export interface WastedTeaching {
  attempts: number;
  /** Taught something the learner demonstrated on the first try at the target level. */
  alreadyKnew: number;
  /** Attempted before its hard prerequisites were met — taught into a gap. */
  taughtIntoGap: number;
  wasteRate: number;
}

/** Read both halves together: a system can look good on one by being bad at the other. (14) */
export async function wastedTeaching(
  prisma: PrismaClient,
  learnerId?: string,
): Promise<WastedTeaching> {
  const events = await prisma.evidenceEvent.findMany({
    where: { ...(learnerId ? { learnerId } : {}), kind: { in: ["applied", "transferred", "failed_check", "restated"] } },
    orderBy: { createdAt: "asc" },
  });

  const firstSeen = new Map<string, string>();
  let alreadyKnew = 0;
  for (const e of events) {
    const key = `${e.learnerId}:${e.conceptId}`;
    if (firstSeen.has(key)) continue;
    firstSeen.set(key, e.kind);
    // First contact was an unaided transfer: they already had it.
    if (e.kind === "transferred") alreadyKnew++;
  }

  const gapFailures = await prisma.evidenceEvent.count({
    where: {
      ...(learnerId ? { learnerId } : {}),
      kind: "failed_check",
      detail: { path: ["diagnosis"], equals: "missing_prerequisite" },
    },
  });

  const attempts = firstSeen.size;
  return {
    attempts,
    alreadyKnew,
    taughtIntoGap: gapFailures,
    wasteRate: attempts === 0 ? 0 : (alreadyKnew + gapFailures) / attempts,
  };
}

export interface PersistenceResult {
  concepts: number;
  held: number;
  /** Fraction of re-probes after a gap that confirmed the earlier estimate. */
  persistenceRate: number;
}

/** Whether a learner returning after a break is still placed correctly. (14) */
export async function crossSessionPersistence(
  prisma: PrismaClient,
  minGapDays = 7,
): Promise<PersistenceResult> {
  const reprobes = await prisma.evidenceEvent.findMany({
    where: { kind: { in: ["reprobe_pass", "reprobe_fail"] } },
    orderBy: { createdAt: "asc" },
  });

  let held = 0;
  let counted = 0;
  for (const r of reprobes) {
    const prior = await prisma.evidenceEvent.findFirst({
      where: {
        learnerId: r.learnerId,
        conceptId: r.conceptId,
        kind: { in: ["applied", "transferred"] },
        createdAt: { lt: r.createdAt },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!prior) continue;
    const gapDays = (r.createdAt.getTime() - prior.createdAt.getTime()) / 86_400_000;
    if (gapDays < minGapDays) continue;
    counted++;
    if (r.kind === "reprobe_pass") held++;
  }
  return { concepts: counted, held, persistenceRate: counted === 0 ? 0 : held / counted };
}

export interface OutcomeCost {
  totalCostUsd: number;
  conceptsMastered: number;
  milestonesCompleted: number;
  /** The metric that matters: cost per hour can be gamed by teaching cheaply and badly. */
  costPerConceptMastered: number | null;
  costPerMilestone: number | null;
  byPurpose: { purpose: string; costUsd: number; calls: number }[];
}

/** Cost per verified outcome, not per hour; expected to fall as the graph accumulates. (17) */
export async function costPerOutcome(
  prisma: PrismaClient,
  w: Window = {},
): Promise<OutcomeCost> {
  const where = w.from || w.to ? { createdAt: range(w) } : {};

  const usage = await prisma.usageRecord.groupBy({
    by: ["purpose"],
    where,
    _sum: { costUsd: true },
    _count: { _all: true },
  });
  const totalCostUsd = usage.reduce((a, u) => a + (u._sum.costUsd ?? 0), 0);

  // LearnerConceptState carries updatedAt, not createdAt — it is mutated in place.
  const states = await prisma.learnerConceptState.findMany({
    where: w.from || w.to ? { updatedAt: range(w) } : {},
  });
  const conceptsMastered = states.filter((s) => atLeast(s.mastery, "functional")).length;
  const milestonesCompleted = await prisma.milestoneInstance.count({
    where: { completedAt: { not: null } },
  });

  return {
    totalCostUsd,
    conceptsMastered,
    milestonesCompleted,
    costPerConceptMastered: conceptsMastered === 0 ? null : totalCostUsd / conceptsMastered,
    costPerMilestone: milestonesCompleted === 0 ? null : totalCostUsd / milestonesCompleted,
    byPurpose: usage
      .map((u) => ({
        purpose: u.purpose,
        costUsd: u._sum.costUsd ?? 0,
        calls: u._count._all,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
  };
}

export interface ArmComparison {
  variant: string;
  learners: number;
  conceptsMastered: number;
  masteredPerLearner: number;
  meanMasteryRank: number;
}

/** Graph-planned against the baseline tutor, which is the experiment. (14) */
export async function compareArms(prisma: PrismaClient): Promise<ArmComparison[]> {
  const sessions = await prisma.session.findMany({ select: { learnerId: true, variant: true } });
  const byVariant = new Map<string, Set<string>>();
  for (const s of sessions) {
    if (!byVariant.has(s.variant)) byVariant.set(s.variant, new Set());
    byVariant.get(s.variant)!.add(s.learnerId);
  }

  const out: ArmComparison[] = [];
  for (const [variant, learners] of byVariant) {
    const states = await prisma.learnerConceptState.findMany({
      where: { learnerId: { in: [...learners] } },
    });
    const mastered = states.filter((s) => atLeast(s.mastery, "functional")).length;
    const meanRank =
      states.length === 0
        ? 0
        : states.reduce((a, s) => a + rank(s.mastery as MasteryLevel), 0) / states.length;
    out.push({
      variant,
      learners: learners.size,
      conceptsMastered: mastered,
      masteredPerLearner: learners.size === 0 ? 0 : mastered / learners.size,
      meanMasteryRank: meanRank,
    });
  }
  return out.sort((a, b) => b.masteredPerLearner - a.masteredPerLearner);
}
