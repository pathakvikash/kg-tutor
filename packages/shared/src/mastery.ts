import type { MasteryLevel, EvidenceKind } from "./enums.js";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./config.js";

const ORDER: MasteryLevel[] = ["unknown", "familiar", "functional", "solid"];

export function rank(level: MasteryLevel): number {
  return ORDER.indexOf(level);
}

export function atLeast(actual: MasteryLevel, required: MasteryLevel): boolean {
  return rank(actual) >= rank(required);
}

export function higher(a: MasteryLevel, b: MasteryLevel): MasteryLevel {
  return rank(a) >= rank(b) ? a : b;
}

/**
 * The level a single piece of evidence can demonstrate. (10)
 *
 * `downstream_success` is the free one: cleanly learning a concept that has this one
 * as a hard prerequisite demonstrates solid understanding of it, with no extra question.
 */
const DEMONSTRATES: Partial<Record<EvidenceKind, MasteryLevel>> = {
  restated: "familiar",
  applied: "functional",
  transferred: "solid",
  downstream_success: "solid",
  reprobe_pass: "functional",
  self_reported_skip: "familiar",
};

/** Mastery only ever moves up here — demotion needs a confirmed re-probe. (06, 10) */
export function promote(current: MasteryLevel, kind: EvidenceKind): MasteryLevel {
  const demonstrated = DEMONSTRATES[kind];
  return demonstrated ? higher(current, demonstrated) : current;
}

/** A single failure never demotes. It lowers confidence and queues a re-probe. (10) */
export function contradicts(kind: EvidenceKind): boolean {
  return kind === "failed_check" || kind === "reprobe_fail" || kind === "misconception_shown";
}

/**
 * Confidence decays with time since evidence; mastery does not. An absence of recent
 * evidence is not proof of forgetting. (06)
 */
export function decayedConfidence(
  base: number,
  lastEvidenceAt: Date | null,
  now: Date,
  t: Thresholds = DEFAULT_THRESHOLDS,
): number {
  if (!lastEvidenceAt) return 0;
  const days = (now.getTime() - lastEvidenceAt.getTime()) / 86_400_000;
  if (days <= 0) return base;
  return base * Math.pow(0.5, days / t.confidenceHalfLifeDays);
}

/**
 * High mastery with low confidence means re-probe, not re-teach — the single reason
 * mastery and confidence are separate fields. (06)
 */
export function needsReprobe(
  mastery: MasteryLevel,
  confidence: number,
  t: Thresholds = DEFAULT_THRESHOLDS,
): boolean {
  return rank(mastery) >= rank("functional") && confidence < t.reprobeConfidenceFloor;
}

/** Inferred mastery may skip teaching; it may not skip probing on the path. (06) */
export function canSkipTeaching(mastery: MasteryLevel, required: MasteryLevel): boolean {
  return atLeast(mastery, required);
}
