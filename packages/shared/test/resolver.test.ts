import { describe, it, expect } from "vitest";
import { actionFor, isWellFormed, shouldAutoMerge, type ResolverCandidate } from "../src/index.js";

const candidate = (over: Partial<ResolverCandidate> = {}): ResolverCandidate => ({
  conceptId: "c1",
  canonicalName: "closures",
  sense: "A function together with the scope it captured.",
  vectorScore: 0.9,
  lexicalScore: 0.5,
  neighborhoodOverlap: 0.4,
  ...over,
});

describe("resolver verdicts", () => {
  it("aliases rather than merging on `same`", () => {
    const a = actionFor({ verdict: "same", relatedConceptId: "c1", reasoning: "" });
    expect(a).toEqual({ kind: "alias", targetConceptId: "c1" });
  });

  it("gives subsumption its own edge instead of forcing a merge", () => {
    expect(actionFor({ verdict: "narrower", relatedConceptId: "c1", reasoning: "" })).toEqual({
      kind: "create",
      relateTo: { conceptId: "c1", type: "contains", direction: "from_existing" },
    });
    expect(actionFor({ verdict: "broader", relatedConceptId: "c1", reasoning: "" })).toEqual({
      kind: "create",
      relateTo: { conceptId: "c1", type: "contains", direction: "to_existing" },
    });
  });

  it("creates with no edge when distinct", () => {
    expect(actionFor({ verdict: "distinct", relatedConceptId: null, reasoning: "" })).toEqual({
      kind: "create",
      relateTo: null,
    });
  });

  it("throws rather than blind-inserting when a verdict names no referent", () => {
    expect(() => actionFor({ verdict: "same", relatedConceptId: null, reasoning: "" })).toThrow(
      /no relatedConceptId/,
    );
  });

  it("requires a referent for every verdict except distinct", () => {
    expect(isWellFormed({ verdict: "same", relatedConceptId: null, reasoning: "" })).toBe(false);
    expect(isWellFormed({ verdict: "distinct", relatedConceptId: null, reasoning: "" })).toBe(true);
  });
});

describe("auto-merge is biased against", () => {
  it("needs high similarity AND corroborating neighborhood overlap", () => {
    expect(shouldAutoMerge(candidate({ vectorScore: 0.97, neighborhoodOverlap: 0.6 }), "same")).toBe(true);
    // High similarity alone is how `promises` and `async/await` get wrongly merged.
    expect(shouldAutoMerge(candidate({ vectorScore: 0.97, neighborhoodOverlap: 0.1 }), "same")).toBe(false);
  });

  it("never fires on a non-`same` verdict", () => {
    expect(shouldAutoMerge(candidate({ vectorScore: 0.99, neighborhoodOverlap: 0.9 }), "narrower")).toBe(false);
  });
});
