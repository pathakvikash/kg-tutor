import { describe, it, expect } from "vitest";
import {
  promote, contradicts, decayedConfidence, needsReprobe, atLeast, higher,
  DEFAULT_THRESHOLDS,
} from "../src/index.js";

describe("mastery ladder", () => {
  it("orders levels", () => {
    expect(atLeast("functional", "familiar")).toBe(true);
    expect(atLeast("familiar", "functional")).toBe(false);
    expect(higher("unknown", "solid")).toBe("solid");
  });

  it("promotes along restate -> apply -> transfer", () => {
    expect(promote("unknown", "restated")).toBe("familiar");
    expect(promote("familiar", "applied")).toBe("functional");
    expect(promote("functional", "transferred")).toBe("solid");
  });

  it("treats downstream success as solid evidence for the prerequisite", () => {
    expect(promote("familiar", "downstream_success")).toBe("solid");
  });

  it("never moves mastery backwards", () => {
    expect(promote("solid", "restated")).toBe("solid");
    expect(promote("solid", "failed_check")).toBe("solid");
    expect(promote("functional", "reprobe_pass")).toBe("functional");
  });

  it("caps a self-reported skip at familiar", () => {
    expect(promote("unknown", "self_reported_skip")).toBe("familiar");
  });

  it("flags contradicting evidence without demoting", () => {
    expect(contradicts("failed_check")).toBe(true);
    expect(contradicts("misconception_shown")).toBe(true);
    expect(contradicts("careless_error")).toBe(false);
  });
});

describe("confidence decay", () => {
  const now = new Date("2026-08-26T00:00:00Z");

  it("halves at the half-life", () => {
    const then = new Date(now.getTime() - DEFAULT_THRESHOLDS.confidenceHalfLifeDays * 86_400_000);
    expect(decayedConfidence(0.8, then, now)).toBeCloseTo(0.4, 5);
  });

  it("does not decay fresh evidence", () => {
    expect(decayedConfidence(0.8, now, now)).toBe(0.8);
  });

  it("is zero with no evidence at all", () => {
    expect(decayedConfidence(0.9, null, now)).toBe(0);
  });

  it("re-probes high mastery once confidence has decayed, and not before", () => {
    expect(needsReprobe("solid", 0.1)).toBe(true);
    expect(needsReprobe("solid", 0.9)).toBe(false);
    expect(needsReprobe("familiar", 0.1)).toBe(false);
  });
});
