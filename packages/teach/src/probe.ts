import type { PrismaClient } from "@kg/db";
import {
  DEFAULT_THRESHOLDS, atLeast, decayedConfidence, needsReprobe,
  type MasteryLevel, type Thresholds,
} from "@kg/shared";

export type ProbeKind = "readiness" | "review";

export interface Probe {
  conceptId: string;
  kind: ProbeKind;
  /** Readiness probes are part of the plan; review probes are the flex. (20) */
  optional: boolean;
  reason: string;
  priority: number;
}

export interface ProbePlanInput {
  prisma: PrismaClient;
  learnerId: string;
  /** The concept about to be taught. Its hard prerequisites drive readiness probes. */
  nextConceptId: string;
  reviewProbesUsedThisSession: number;
  now?: Date;
  thresholds?: Thresholds;
}

/**
 * Re-probes get no budget of their own — they ride the hook slot of the next concept
 * attempt, so they consume time that was already being spent. (20)
 *
 * The split is what does the work:
 *   - readiness: on a hard prerequisite of what is about to be taught. Skipping one
 *     means teaching into a gap, so it is not optional and not budgeted.
 *   - review: maintenance on decayed confidence elsewhere. First thing cut when the
 *     session runs short, because new material is why the learner showed up.
 */
export async function selectProbes(input: ProbePlanInput): Promise<Probe[]> {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const now = input.now ?? new Date();

  const prereqs = await input.prisma.edge.findMany({
    where: {
      dstId: input.nextConceptId, type: "prerequisite_of",
      strength: "hard", retiredAt: null,
    },
  });
  const states = await input.prisma.learnerConceptState.findMany({
    where: { learnerId: input.learnerId },
  });
  const byConcept = new Map(states.map((s) => [s.conceptId, s]));

  const probes: Probe[] = [];

  for (const e of prereqs) {
    const s = byConcept.get(e.srcId);
    if (!s) continue; // never seen: this is a teaching gap, not a probe
    const confidence = decayedConfidence(s.confidence, s.lastEvidenceAt, now, t);
    const inferred = s.source === "inferred";
    const stale = confidence < t.reprobeConfidenceFloor;
    if (!atLeast(s.mastery, "functional")) continue;
    if (!stale && !inferred) continue;
    probes.push({
      conceptId: e.srcId,
      kind: "readiness",
      optional: false,
      reason: inferred
        ? "mastery here was inferred, never demonstrated, and it gates the next concept"
        : "confidence has decayed on a hard prerequisite of the next concept",
      priority: 1 - confidence,
    });
  }

  const readinessIds = new Set(probes.map((p) => p.conceptId));
  const remaining = Math.max(
    0,
    t.maxReviewProbesPerSession - input.reviewProbesUsedThisSession,
  );

  if (remaining > 0) {
    const due = states
      .filter((s) => !readinessIds.has(s.conceptId))
      .map((s) => ({
        s,
        confidence: decayedConfidence(s.confidence, s.lastEvidenceAt, now, t),
      }))
      .filter((x) => needsReprobe(x.s.mastery as MasteryLevel, x.confidence, t))
      .sort((a, b) => a.confidence - b.confidence)
      .slice(0, remaining);

    for (const d of due) {
      probes.push({
        conceptId: d.s.conceptId,
        kind: "review",
        optional: true,
        reason: "high mastery with decayed confidence — cheaper to re-probe than re-teach",
        priority: 1 - d.confidence,
      });
    }
  }

  return probes.sort(
    (a, b) => Number(a.optional) - Number(b.optional) || b.priority - a.priority,
  );
}

/**
 * What survives when a session runs short. Readiness probes always survive; review
 * probes are dropped first. (20)
 */
export function trimToTimeBudget(probes: Probe[], slots: number): Probe[] {
  const required = probes.filter((p) => !p.optional);
  if (required.length >= slots) return required;
  return [...required, ...probes.filter((p) => p.optional).slice(0, slots - required.length)];
}
