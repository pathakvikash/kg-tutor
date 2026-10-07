import { describe, it, expect } from "vitest";
import { consensus, normalizeKey } from "../src/consensus.js";

const key = (x: { name: string }) => normalizeKey(x.name);
const n = (name: string) => ({ name });

describe("normalizeKey", () => {
  it("collapses case, spacing and punctuation so variants vote together", () => {
    expect(normalizeKey("The Event Loop")).toBe("event loop");
    expect(normalizeKey("the event loop")).toBe(normalizeKey("event loop"));
    expect(normalizeKey("event-loop")).toBe(normalizeKey("event loop"));
    expect(normalizeKey("  async/await  ")).toBe("async await");
  });
});

describe("consensus", () => {
  it("keeps what a majority of samples agree on", () => {
    const { survived, dropped } = consensus(
      [
        [n("closures"), n("scope"), n("hoisting")],
        [n("closures"), n("scope"), n("currying")],
        [n("closures"), n("scope"), n("iife")],
      ],
      { key },
    );
    expect(survived.map((s) => s.value.name)).toEqual(["closures", "scope"]);
    expect(dropped.map((d) => d.value.name).sort()).toEqual(["currying", "hoisting", "iife"]);
  });

  it("matches variants across samples despite phrasing differences", () => {
    const { survived } = consensus(
      [[n("The Event Loop")], [n("event loop")], [n("event-loop")]],
      { key },
    );
    expect(survived).toHaveLength(1);
    expect(survived[0]?.votes).toBe(3);
    expect(survived[0]?.variants).toHaveLength(3);
  });

  it("does not let one sample vote twice by repeating an item", () => {
    const { survived, dropped } = consensus(
      [[n("closures"), n("Closures"), n("CLOSURES")], [n("scope")], [n("scope")]],
      { key },
    );
    expect(survived.map((s) => s.value.name)).toEqual(["scope"]);
    expect(dropped[0]?.votes).toBe(1);
  });

  it("honours an explicit threshold", () => {
    const samples = [[n("a")], [n("a")], [n("b")]];
    expect(consensus(samples, { key, threshold: 3 }).survived).toHaveLength(0);
    expect(consensus(samples, { key, threshold: 1 }).survived).toHaveLength(2);
  });

  it("survives an empty sample without dropping the others' votes", () => {
    const { survived } = consensus([[n("a")], [], [n("a")]], { key });
    expect(survived[0]?.votes).toBe(2);
  });
});
