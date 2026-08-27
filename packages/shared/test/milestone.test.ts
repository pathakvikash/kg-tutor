import { describe, it, expect } from "vitest";
import { trimMilestone, type MasteryLevel, type MilestoneRequirement } from "../src/index.js";

const reqs: MilestoneRequirement[] = [
  { conceptId: "a", requiredLevel: "functional" },
  { conceptId: "b", requiredLevel: "functional" },
  { conceptId: "c", requiredLevel: "functional" },
  { conceptId: "d", requiredLevel: "solid" },
];

const state = (m: Record<string, MasteryLevel>) => (id: string) => m[id] ?? "unknown";

describe("milestone trimming", () => {
  it("keeps only what the learner has not reached", () => {
    const r = trimMilestone(reqs, state({ a: "solid", b: "functional" }));
    expect(r.remaining.map((x) => x.conceptId)).toEqual(["c", "d"]);
    expect(r.foldForward).toBe(false);
  });

  it("respects the required level, not just presence", () => {
    // `functional` does not satisfy a `solid` requirement.
    const r = trimMilestone(reqs, state({ a: "solid", b: "solid", c: "solid", d: "functional" }));
    expect(r.remaining.map((x) => x.conceptId)).toEqual(["d"]);
    expect(r.foldForward).toBe(true);
  });

  it("folds forward rather than awarding a hollow completion", () => {
    const r = trimMilestone(reqs, state({ a: "solid", b: "solid", c: "solid", d: "solid" }));
    expect(r.remaining).toHaveLength(0);
    expect(r.foldForward).toBe(true);
  });

  it("does not fold when a real share is still new", () => {
    const r = trimMilestone(reqs, state({ a: "solid", b: "solid" }));
    expect(r.foldForward).toBe(false);
  });
});

describe("malformed milestones", () => {
  it("does not treat a milestone with no concepts as satisfied", () => {
    // "Nothing required" is not "everything done".
    const r = trimMilestone([], () => "unknown");
    expect(r.malformed).toBe(true);
    expect(r.foldForward).toBe(false);
    expect(r.satisfied).toHaveLength(0);
  });

  it("still flags a genuinely satisfied milestone as folded, not malformed", () => {
    const r = trimMilestone(reqs, state({ a: "solid", b: "solid", c: "solid", d: "solid" }));
    expect(r.malformed).toBe(false);
    expect(r.foldForward).toBe(true);
  });
});
