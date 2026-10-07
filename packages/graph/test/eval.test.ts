import { describe, it, expect } from "vitest";
import type { ResolverVerdict } from "@kg/shared";
import { PAIRS } from "../eval/pairs.js";
import { scoreAdjudicator, formatReport } from "../eval/score.js";
import type { AdjudicationInput, Adjudicator } from "../src/adjudicate.js";

class Fixed implements Adjudicator {
  readonly name = "fixed";
  constructor(private readonly f: (i: AdjudicationInput) => ResolverVerdict) {}
  async adjudicate(i: AdjudicationInput) {
    const verdict = this.f(i);
    return {
      verdict,
      relatedConceptId: verdict === "distinct" ? null : (i.candidates[0]?.conceptId ?? null),
      reasoning: "fixed",
    };
  }
}

describe("labelled pairs", () => {
  it("covers every verdict the resolver can return except unusable ones", () => {
    const covered = new Set(PAIRS.map((p) => p.expected));
    expect([...covered].sort()).toEqual(["broader", "distinct", "narrower", "related", "same"].sort());
  });

  it("has unique ids and states what each pair is testing", () => {
    expect(new Set(PAIRS.map((p) => p.id)).size).toBe(PAIRS.length);
    expect(PAIRS.every((p) => p.tests.length > 20)).toBe(true);
  });
});

describe("scoreAdjudicator", () => {
  it("scores a perfect adjudicator at 100% with no weighted error", async () => {
    const oracle = new Fixed((i) => PAIRS.find((p) => p.proposed.name === i.proposedName)!.expected);
    const r = await scoreAdjudicator(oracle);
    expect(r.accuracy).toBe(1);
    expect(r.weightedError).toBe(0);
    expect(r.falseSames).toHaveLength(0);
  });

  it("punishes a merge-happy adjudicator far harder than a cautious one", async () => {
    const mergeHappy = await scoreAdjudicator(new Fixed(() => "same"));
    const overCautious = await scoreAdjudicator(new Fixed(() => "distinct"));

    expect(mergeHappy.falseSames.length).toBeGreaterThan(0);
    expect(overCautious.falseSames).toHaveLength(0);
    expect(mergeHappy.weightedError).toBeGreaterThan(overCautious.weightedError * 3);
  });

  it("counts a missed duplicate without treating it as catastrophic", async () => {
    const r = await scoreAdjudicator(new Fixed(() => "distinct"));
    expect(r.falseDistincts.length).toBeGreaterThan(0);
    expect(r.falseSames).toHaveLength(0);
  });

  it("names the false-same pairs in the report so they can be inspected", async () => {
    const text = formatReport(await scoreAdjudicator(new Fixed(() => "same")));
    expect(text).toContain("FALSE SAME");
    expect(text).toContain("homonym-model-ml-mvc");
  });
});
