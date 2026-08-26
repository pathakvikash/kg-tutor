import type { PrismaClient } from "@kg/db";
import {
  DEFAULT_THRESHOLDS, atLeast, decayedConfidence, needsReprobe,
  type MasteryLevel, type Thresholds,
} from "@kg/shared";

/**
 * What a learner owes attention to right now, independent of any plan.
 *
 * `selectProbes` answers a narrower question — what to check before the *next plan step* —
 * so it needs a next concept and caps itself at two review probes. That is right inside a
 * lesson and useless as a way back in: confidence decays on a 45-day half life whether or
 * not the learner opens the next step, and nothing was telling them that anything had
 * gone stale. The decay model was being computed and then dropped.
 *
 * Three kinds, in the order they matter:
 *
 *   - **misconception** — a wrong belief was recorded and never resolved. Actively worse
 *     than not knowing, because the learner will apply it. Nothing in the system had ever
 *     set `resolvedAt`, so these were write-only: recorded, listed on one page, and never
 *     acted on again.
 *   - **inferred** — mastery credited from downstream success, never demonstrated
 *     directly. Cheap to confirm, and load-bearing if anything was built on it. (06)
 *   - **decayed** — held at a real level once, and confidence has since fallen below the
 *     re-probe floor. Cheaper to re-probe than to re-teach.
 */
export type DueKind = "misconception" | "inferred" | "decayed";

export interface DueItem {
  conceptId: string;
  conceptName: string;
  kind: DueKind;
  /** Shown to the learner, so it has to say why this and not something else. */
  reason: string;
  mastery: MasteryLevel;
  /** Decay already applied, so this is what it is worth today. */
  confidence: number;
  /** For a misconception: the belief in the learner's own terms. */
  belief?: string;
  priority: number;
}

const RANK: Record<DueKind, number> = { misconception: 2, inferred: 1, decayed: 0 };

export async function dueForReview(
  prisma: PrismaClient,
  learnerId: string,
  opts: { now?: Date; limit?: number; thresholds?: Thresholds } = {},
): Promise<DueItem[]> {
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const now = opts.now ?? new Date();

  const states = await prisma.learnerConceptState.findMany({
    where: { learnerId, concept: { deprecatedAt: null } },
    include: { concept: true },
  });
  const misconceptions = await prisma.misconception.findMany({
    where: { learnerId, resolvedAt: null, concept: { deprecatedAt: null } },
    include: { concept: true },
    orderBy: { observedCount: "desc" },
  });

  const out = new Map<string, DueItem>();

  for (const m of misconceptions) {
    const state = states.find((s) => s.conceptId === m.conceptId);
    const confidence = state
      ? decayedConfidence(state.confidence, state.lastEvidenceAt, now, t)
      : 0;
    out.set(m.conceptId, {
      conceptId: m.conceptId,
      conceptName: m.concept.canonicalName,
      kind: "misconception",
      reason:
        m.observedCount > 1
          ? `a wrong belief here has shown up ${m.observedCount} times and has not been cleared`
          : "a wrong belief was recorded here and never checked again",
      mastery: (state?.mastery ?? "unknown") as MasteryLevel,
      confidence,
      belief: m.belief,
      // Above everything: a held misconception gets applied, so it does damage.
      priority: 2 + Math.min(m.observedCount, 5) / 10,
    });
  }

  for (const s of states) {
    if (out.has(s.conceptId)) continue;
    const confidence = decayedConfidence(s.confidence, s.lastEvidenceAt, now, t);
    const mastery = s.mastery as MasteryLevel;

    if (s.source === "inferred" && atLeast(mastery, "functional")) {
      out.set(s.conceptId, {
        conceptId: s.conceptId,
        conceptName: s.concept.canonicalName,
        kind: "inferred",
        reason: "credited from downstream success, never demonstrated directly",
        mastery,
        confidence,
        priority: 1 + (1 - confidence) / 10,
      });
      continue;
    }
    if (needsReprobe(mastery, confidence, t)) {
      out.set(s.conceptId, {
        conceptId: s.conceptId,
        conceptName: s.concept.canonicalName,
        kind: "decayed",
        reason: `held at ${mastery}, confidence has fallen to ${confidence.toFixed(2)}`,
        mastery,
        confidence,
        priority: 1 - confidence,
      });
    }
  }

  const sorted = [...out.values()].sort(
    (a, b) => RANK[b.kind] - RANK[a.kind] || b.priority - a.priority,
  );
  return opts.limit ? sorted.slice(0, opts.limit) : sorted;
}

/**
 * Clears misconceptions on a concept the learner has just demonstrated.
 *
 * A recorded belief that is never cleared makes the concept due forever, so the review
 * queue would only ever grow. Only a real demonstration counts: a restatement is not
 * evidence that the belief is gone. (10, 16)
 */
export async function resolveMisconceptions(
  prisma: PrismaClient,
  learnerId: string,
  conceptId: string,
): Promise<number> {
  const { count } = await prisma.misconception.updateMany({
    where: { learnerId, conceptId, resolvedAt: null },
    data: { resolvedAt: new Date() },
  });
  return count;
}
