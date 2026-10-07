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

const DEMONSTRATES: Partial<Record<EvidenceKind, MasteryLevel>> = {
  restated: "familiar",
  applied: "functional",
  transferred: "solid",
  downstream_success: "solid",
  reprobe_pass: "functional",
  self_reported_skip: "familiar",
};

/** Mastery only moves up here; demotion needs a confirmed re-probe */
export function promote(current: MasteryLevel, kind: EvidenceKind): MasteryLevel {
  const demonstrated = DEMONSTRATES[kind];
  return demonstrated ? higher(current, demonstrated) : current;
}

export function contradicts(kind: EvidenceKind): boolean {
  return kind === "failed_check" || kind === "reprobe_fail" || kind === "misconception_shown";
}

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

export function needsReprobe(
  mastery: MasteryLevel,
  confidence: number,
  t: Thresholds = DEFAULT_THRESHOLDS,
): boolean {
  return rank(mastery) >= rank("functional") && confidence < t.reprobeConfidenceFloor;
}

/** Inferred mastery may skip teaching but not probing on the path */
export function canSkipTeaching(mastery: MasteryLevel, required: MasteryLevel): boolean {
  return atLeast(mastery, required);
}
