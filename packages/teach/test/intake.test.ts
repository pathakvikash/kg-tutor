import { describe, it, expect } from "vitest";
import {
  buildChains, initialState, nextProbe, applyAnswer, derivedBeliefs,
} from "../src/intake.js";
import { DEFAULT_THRESHOLDS } from "@kg/shared";

/** a → b → c → d → e, plus a side branch a → x → y. */
const EDGES = [
  { srcId: "a", dstId: "b" }, { srcId: "b", dstId: "c" },
  { srcId: "c", dstId: "d" }, { srcId: "d", dstId: "e" },
  { srcId: "a", dstId: "x" }, { srcId: "x", dstId: "y" },
];
const IDS = ["a", "b", "c", "d", "e", "x", "y"];

describe("buildChains", () => {
  it("walks back from each leaf to a foundation, ordered foundation-first", () => {
    const chains = buildChains(IDS, EDGES);
    expect(chains).toContainEqual(["a", "b", "c", "d", "e"]);
    expect(chains).toContainEqual(["a", "x", "y"]);
  });

  it("ignores edges leaving the topic", () => {
    const chains = buildChains(["a", "b"], [...EDGES, { srcId: "outside", dstId: "a" }]);
    expect(chains).toEqual([["a", "b"]]);
  });

  it("drops single-concept chains when a searchable one exists", () => {
    const chains = buildChains([...IDS, "lone"], EDGES);
    expect(chains).not.toContainEqual(["lone"]);
    expect(chains).toContainEqual(["a", "b", "c", "d", "e"]);
  });

  it("keeps single-concept chains when the topic has no edges at all", () => {
    const chains = buildChains(["solo", "other"], []);
    expect(chains).toEqual([["solo"], ["other"]]);
  });

  it("terminates on a cycle rather than looping forever", () => {
    const chains = buildChains(["p", "q"], [{ srcId: "p", dstId: "q" }, { srcId: "q", dstId: "p" }]);
    expect(chains.length).toBeGreaterThan(0);
    expect(chains.every((c) => c.length <= 2)).toBe(true);
  });

  it("handles a topic with no edges at all", () => {
    expect(buildChains(["solo"], [])).toEqual([["solo"]]);
  });
});

describe("binary-search probing", () => {
  it("starts in the middle of a chain, not at the foundation", () => {
    // Asking about the most basic thing first wastes the budget on a near-certain pass.
    const state = initialState([["a", "b", "c", "d", "e"]]);
    const probe = nextProbe(state);
    expect(probe?.conceptId).toBe("c");
    expect(probe?.position).toBe(2);
  });

  it("moves up on a pass — everything below is taken as known", () => {
    let state = initialState([["a", "b", "c", "d", "e"]]);
    const first = nextProbe(state)!;
    state = applyAnswer(state, first, true);
    const second = nextProbe(state)!;
    expect(second.position).toBeGreaterThan(first.position);
  });

  it("descends on a failure", () => {
    let state = initialState([["a", "b", "c", "d", "e"]]);
    const first = nextProbe(state)!;
    state = applyAnswer(state, first, false);
    const second = nextProbe(state)!;
    expect(second.position).toBeLessThan(first.position);
  });

  it("finds where knowledge stops in about log(n) questions", () => {
    // Learner knows a, b, c but not d or e.
    const known = new Set(["a", "b", "c"]);
    let state = initialState([["a", "b", "c", "d", "e"]]);
    let asked = 0;
    for (;;) {
      const p = nextProbe(state);
      if (!p) break;
      state = applyAnswer(state, p, known.has(p.conceptId));
      asked++;
    }
    expect(asked).toBeLessThanOrEqual(3);
    const beliefs = new Map(derivedBeliefs(state).map((b) => [b.conceptId, b]));
    expect(beliefs.get("c")?.mastery).toBe("functional");
    expect(beliefs.get("d")?.mastery).toBe("unknown");
  });

  it("covers chains breadth-first rather than draining one", () => {
    let state = initialState([["a", "b", "c", "d", "e"], ["a", "x", "y"]]);
    const chainsHit = new Set<number>();
    for (let i = 0; i < 2; i++) {
      const p = nextProbe(state)!;
      chainsHit.add(p.chainIndex);
      state = applyAnswer(state, p, true);
    }
    expect(chainsHit.size).toBe(2);
  });

  it("stops early once a chain is resolved, without spending the whole budget", () => {
    // Binary search converges in about log2(n), so the full budget is not needed.
    const long = Array.from({ length: 60 }, (_, i) => `c${i}`);
    let state = initialState([long]);
    let asked = 0;
    for (;;) {
      const p = nextProbe(state);
      if (!p) break;
      state = applyAnswer(state, p, asked % 2 === 0);
      asked++;
    }
    expect(asked).toBeLessThanOrEqual(DEFAULT_THRESHOLDS.maxInitialProbes);
    expect(asked).toBeGreaterThanOrEqual(5);
  });

  it("hard-stops at the budget when many chains remain unresolved", () => {
    // The cap is a product constraint: leftover uncertainty is corrected by teaching.
    const chains = Array.from({ length: 12 }, (_, c) =>
      Array.from({ length: 40 }, (_, i) => `chain${c}-${i}`),
    );
    let state = initialState(chains);
    let asked = 0;
    for (;;) {
      const p = nextProbe(state);
      if (!p) break;
      state = applyAnswer(state, p, false);
      asked++;
    }
    expect(asked).toBe(DEFAULT_THRESHOLDS.maxInitialProbes);
    // And plenty is still unknown, which is the accepted trade.
    expect(state.chains.filter((c) => c.lo <= c.hi).length).toBeGreaterThan(0);
  });

  it("does not ask the same concept twice across overlapping chains", () => {
    let state = initialState([["a", "b", "c"], ["a", "b", "d"]]);
    const seen: string[] = [];
    for (;;) {
      const p = nextProbe(state);
      if (!p) break;
      seen.push(p.conceptId);
      state = applyAnswer(state, p, false);
    }
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("derivedBeliefs", () => {
  it("marks probed concepts assessed and implied ones inferred", () => {
    let state = initialState([["a", "b", "c", "d", "e"]]);
    const p = nextProbe(state)!; // "c"
    state = applyAnswer(state, p, true);
    const beliefs = new Map(derivedBeliefs(state).map((b) => [b.conceptId, b]));

    expect(beliefs.get("c")).toMatchObject({ mastery: "functional", source: "assessed" });
    // a and b sit below a passed probe, so they are believed but not demonstrated.
    expect(beliefs.get("a")).toMatchObject({ source: "inferred" });
    expect(beliefs.get("b")).toMatchObject({ source: "inferred" });
    // Nothing above the probe is claimed at all.
    expect(beliefs.get("d")).toBeUndefined();
  });

  it("lets direct evidence override an inference", () => {
    let state = initialState([["a", "b", "c"]]);
    state = applyAnswer(state, { conceptId: "c", chainIndex: 0, position: 2, chainLength: 3 }, true);
    state = applyAnswer(state, { conceptId: "a", chainIndex: 0, position: 0, chainLength: 3 }, false);
    const beliefs = new Map(derivedBeliefs(state).map((b) => [b.conceptId, b]));
    expect(beliefs.get("a")).toMatchObject({ mastery: "unknown", source: "assessed" });
  });

  it("claims nothing when nothing was asked", () => {
    expect(derivedBeliefs(initialState([["a", "b"]]))).toEqual([]);
  });
});
