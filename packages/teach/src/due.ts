import type { PrismaClient } from "@kg/db";
import {
  DEFAULT_THRESHOLDS, atLeast, decayedConfidence, needsReprobe,
  type MasteryLevel, type Thresholds,
} from "@kg/shared";

export type DueKind = "misconception" | "inferred" | "decayed";

export interface DueItem {
  conceptId: string;
  conceptName: string;
  kind: DueKind;
  reason: string;
  mastery: MasteryLevel;
  confidence: number;
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
      // Above everything: a held misconception gets applied, so it does damage
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

/** Call only on a real demonstration; an uncleared belief keeps the concept due forever */
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
