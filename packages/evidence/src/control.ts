import type { PrismaClient } from "@kg/db";
import { DEFAULT_THRESHOLDS, atLeast, type MasteryLevel, type Thresholds } from "@kg/shared";

export interface ControlledClaim {
  prerequisiteId: string;
  targetId: string;
  /** Learners who did NOT know the prerequisite when they attempted the target. */
  treatmentN: number;
  treatmentFailureRate: number;
  /** Learners who DID know it. Without this arm, difficulty is promoted as prerequisite. */
  controlN: number;
  controlFailureRate: number;
  effectSize: number;
  distinctLearners: number;
  distinctGoals: number;
  passes: boolean;
  /** Why it failed, so a near-miss is visible instead of silently absent. */
  rejectedFor: string[];
}

interface Attempt {
  learnerId: string;
  failed: boolean;
  knewPrerequisite: boolean;
  goalId: string | null;
}

/**
 * Tests one "A is a prerequisite of B" claim against evidence. (11)
 *
 * The control arm is the piece that is easy to skip and expensive to skip. "Learners who
 * failed B were missing A" is true of almost any hard concept, because weak learners
 * fail everything. The question that actually carries information is whether learners
 * who *knew* A failed B *less*. Without asking it, the system systematically promotes
 * difficulty as dependency and the graph fills with confident nonsense.
 *
 * This is observational data with real selection effects. The control arm reduces the
 * confounding; it does not eliminate it, which is why promotion stays reversible.
 */
export async function evaluateClaim(
  prisma: PrismaClient,
  prerequisiteId: string,
  targetId: string,
  t: Thresholds = DEFAULT_THRESHOLDS,
): Promise<ControlledClaim> {
  const events = await prisma.evidenceEvent.findMany({
    where: {
      conceptId: targetId,
      kind: { in: ["applied", "transferred", "failed_check", "misconception_shown"] },
    },
    orderBy: { createdAt: "asc" },
  });

  const attempts: Attempt[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.learnerId)) continue; // first attempt only; later ones are post-teaching
    seen.add(e.learnerId);

    // What did they know about the prerequisite *before* attempting the target?
    const priorEvidence = await prisma.evidenceEvent.findFirst({
      where: {
        learnerId: e.learnerId,
        conceptId: prerequisiteId,
        kind: { in: ["applied", "transferred", "reprobe_pass"] },
        createdAt: { lt: e.createdAt },
      },
    });
    const goal = await prisma.goal.findFirst({
      where: { learnerId: e.learnerId }, orderBy: { createdAt: "desc" },
    });

    attempts.push({
      learnerId: e.learnerId,
      failed: e.kind === "failed_check" || e.kind === "misconception_shown",
      knewPrerequisite: priorEvidence !== null,
      goalId: goal?.id ?? null,
    });
  }

  const treatment = attempts.filter((a) => !a.knewPrerequisite);
  const control = attempts.filter((a) => a.knewPrerequisite);
  const rate = (xs: Attempt[]) =>
    xs.length === 0 ? 0 : xs.filter((x) => x.failed).length / xs.length;

  const treatmentFailureRate = rate(treatment);
  const controlFailureRate = rate(control);
  const effectSize = treatmentFailureRate - controlFailureRate;
  const distinctLearners = attempts.length;
  const distinctGoals = new Set(attempts.map((a) => a.goalId).filter(Boolean)).size;

  const rejectedFor: string[] = [];
  if (distinctLearners < t.minDistinctLearnersForPromotion) {
    rejectedFor.push(`only ${distinctLearners} distinct learners`);
  }
  if (control.length === 0) {
    rejectedFor.push("no control arm — nobody attempted the target already knowing it");
  }
  if (effectSize < 0.2) {
    rejectedFor.push(`effect size ${effectSize.toFixed(2)} below 0.20`);
  }
  if (distinctGoals < t.minDistinctGoalsForPromotion) {
    rejectedFor.push(`evidence spans only ${distinctGoals} goal(s)`);
  }

  return {
    prerequisiteId,
    targetId,
    treatmentN: treatment.length,
    treatmentFailureRate,
    controlN: control.length,
    controlFailureRate,
    effectSize,
    distinctLearners,
    distinctGoals,
    passes: rejectedFor.length === 0,
    rejectedFor,
  };
}

/** Mastery at or above this counts as "knew it" for the control split. */
export function knewIt(mastery: MasteryLevel | undefined): boolean {
  return atLeast(mastery ?? "unknown", "functional");
}
