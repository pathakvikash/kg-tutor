import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { ScriptedLLM } from "@kg/llm";
import {
  generateItems, selectItem, updateItemStats, promoteExplanations, isWrongLanguage,
} from "../src/content.js";
import { prisma, reset, concept, learner, hardEdge } from "./helpers.js";

const FM = "The learner predicts a zero-delay timer runs before the current function returns.";

const itemLLM = () =>
  new ScriptedLLM(() =>
    JSON.stringify({
      items: [
        { prompt: "State what a promise represents.", targetsLevel: "familiar",
          requiresTransfer: false, mustDemonstrate: ["a value that settles later"] },
        { prompt: "Predict the log order in this snippet.", targetsLevel: "functional",
          requiresTransfer: false, mustDemonstrate: ["defers the callback"] },
        { prompt: "Given this unfamiliar scheduler, order the output.", targetsLevel: "solid",
          requiresTransfer: true, mustDemonstrate: ["applies the model to a new runtime"] },
      ],
    }),
  );

beforeEach(reset);
afterAll(async () => { await prisma.$disconnect(); });

describe("generateItems", () => {
  it("stores items as candidates spanning the levels, including a transfer item", async () => {
    const c = await concept("promises");
    expect(await generateItems(prisma, itemLLM(), c)).toEqual({ created: 3 });

    const items = await prisma.assessmentItem.findMany({ where: { conceptId: c } });
    expect(items.every((i) => i.status === "candidate")).toBe(true);
    expect(items.map((i) => i.targetsLevel).sort()).toEqual(["familiar", "functional", "solid"]);
    // Without a transfer item a fluent paraphrase would promote to solid. (16)
    expect(items.some((i) => i.requiresTransfer)).toBe(true);
  });

  it("passes the concept's failure modes in as things to probe for", async () => {
    const pre = await concept("the event loop");
    const c = await concept("promises");
    await hardEdge(pre, c, FM);
    const llm = itemLLM();
    await generateItems(prisma, llm, c);
    expect(llm.calls[0]?.user).toContain(FM);
  });

  it("does not duplicate an item it already stored", async () => {
    const c = await concept("promises");
    await generateItems(prisma, itemLLM(), c);
    expect(await generateItems(prisma, itemLLM(), c)).toEqual({ created: 0 });
    expect(await prisma.assessmentItem.count({ where: { conceptId: c } })).toBe(3);
  });
});

describe("selectItem", () => {
  it("prefers canonical, then better discrimination", async () => {
    const c = await concept("promises");
    const mk = (status: "candidate" | "canonical", discrimination: number) =>
      prisma.assessmentItem.create({
        data: { conceptId: c, prompt: `${status}-${discrimination}`, rubric: {},
          targetsLevel: "functional", status, discrimination },
      });
    await mk("candidate", 0.9);
    const good = await mk("canonical", 0.3);
    expect((await selectItem(prisma, c, "functional"))?.id).toBe(good.id);
  });

  it("never returns a retired item, and returns null when nothing is left", async () => {
    const c = await concept("promises");
    await prisma.assessmentItem.create({
      data: { conceptId: c, prompt: "x", rubric: {}, targetsLevel: "functional", status: "retired" },
    });
    expect(await selectItem(prisma, c, "functional")).toBeNull();
  });

  it("honours the exclusion list so a learner is not re-shown the same item", async () => {
    const c = await concept("promises");
    const a = await prisma.assessmentItem.create({
      data: { conceptId: c, prompt: "a", rubric: {}, targetsLevel: "functional" },
    });
    const b = await prisma.assessmentItem.create({
      data: { conceptId: c, prompt: "b", rubric: {}, targetsLevel: "functional" },
    });
    expect((await selectItem(prisma, c, "functional", [a.id]))?.id).toBe(b.id);
  });
});

describe("updateItemStats", () => {
  it("retires an item everybody passes — it separates nobody", async () => {
    const c = await concept("promises");
    const item = await prisma.assessmentItem.create({
      data: { conceptId: c, prompt: "trivial", rubric: {}, targetsLevel: "functional",
        timesUsed: 100, correctCount: 100 },
    });
    const [r] = await updateItemStats(prisma, c);
    expect(r).toMatchObject({ itemId: item.id, action: "retired" });
    expect((await prisma.assessmentItem.findUniqueOrThrow({ where: { id: item.id } })).status)
      .toBe("retired");
  });

  it("leaves an item with too little use alone", async () => {
    const c = await concept("promises");
    await prisma.assessmentItem.create({
      data: { conceptId: c, prompt: "new", rubric: {}, targetsLevel: "functional",
        timesUsed: 5, correctCount: 5 },
    });
    expect(await updateItemStats(prisma, c)).toEqual([]);
  });

  it("promotes an item whose result predicts downstream success", async () => {
    const c = await concept("closures");
    const downstream = await concept("memoization");
    await hardEdge(c, downstream, FM);

    const item = await prisma.assessmentItem.create({
      data: { conceptId: c, prompt: "q", rubric: {}, targetsLevel: "functional",
        timesUsed: 40, correctCount: 20 },
    });

    // Everyone who passed the item went on to succeed downstream; nobody who failed did.
    for (let i = 0; i < 10; i++) {
      const l = await learner();
      await prisma.evidenceEvent.create({
        data: { learnerId: l, conceptId: c, kind: "applied", itemId: item.id },
      });
      await prisma.evidenceEvent.create({
        data: { learnerId: l, conceptId: downstream, kind: "applied" },
      });
    }
    for (let i = 0; i < 10; i++) {
      const l = await learner();
      await prisma.evidenceEvent.create({
        data: { learnerId: l, conceptId: c, kind: "failed_check", itemId: item.id },
      });
    }

    const [r] = await updateItemStats(prisma, c);
    expect(r?.discrimination).toBeGreaterThan(0.2);
    expect(r?.action).toBe("promoted");
  });
});

describe("promoteExplanations", () => {
  it("promotes what works, retires what does not, leaves the middle alone", async () => {
    const c = await concept("promises");
    const mk = (shown: number, passed: number) =>
      prisma.explanationContent.create({
        data: { conceptId: c, claims: `c${shown}-${passed}`, timesShown: shown, followedByPass: passed },
      });
    const good = await mk(100, 80);
    const bad = await mk(100, 10);
    const middling = await mk(100, 50);
    const thin = await mk(5, 5);

    const results = await promoteExplanations(prisma, c);
    const byId = Object.fromEntries(results.map((r) => [r.contentId, r.action]));
    expect(byId[good.id]).toBe("promoted");
    expect(byId[bad.id]).toBe("retired");
    expect(byId[middling.id]).toBe("kept");
    expect(byId[thin.id]).toBeUndefined();
  });
});

describe("language-aware item selection", () => {
  /** Explicit rather than a partial spread: exactOptionalPropertyTypes rejects the latter. */
  let seq = 0;
  const make = (
    conceptId: string,
    code: string | null,
    codeLanguage: string | null,
    discrimination = 0.5,
    status: "candidate" | "canonical" = "candidate",
  ) =>
    prisma.assessmentItem.create({
      data: {
        conceptId,
        prompt: `prompt ${seq++}`,
        code,
        codeLanguage,
        rubric: { mustDemonstrate: ["something"] },
        targetsLevel: "functional",
        requiresTransfer: false,
        status,
        discrimination,
      },
    });

  it("prefers the learner's language over a better-performing item in another", async () => {
    const c = await concept("some concept");
    await make(c, "int x[10];", "c", 0.9, "canonical");
    const want = await make(c, "const x = [];", "javascript", 0.1);
    const picked = await selectItem(prisma, c, "functional", [], { language: "JavaScript" });
    expect(picked?.id).toBe(want.id);
  });

  it("treats TypeScript as close enough to JavaScript", async () => {
    const c = await concept("some concept");
    const ts = await make(c, "const x: number[] = [];", "typescript");
    await make(c, "int x[10];", "c");
    const picked = await selectItem(prisma, c, "functional", [], { language: "javascript" });
    expect(picked?.id).toBe(ts.id);
  });

  it("accepts an item with no code at all — prose is language-neutral", async () => {
    const c = await concept("some concept");
    const prose = await make(c, null, null);
    await make(c, "int x[10];", "c");
    const picked = await selectItem(prisma, c, "functional", [], { language: "JavaScript" });
    expect(picked?.id).toBe(prose.id);
  });

  it("still returns a wrong-language item when it is the only one", async () => {
    const c = await concept("some concept");
    const only = await make(c, "int x[10];", "c");
    const picked = await selectItem(prisma, c, "functional", [], { language: "JavaScript" });
    expect(picked?.id).toBe(only.id);
    // ...and the caller is told, so it can generate a variant instead of asking it.
    expect(isWrongLanguage(picked!, "JavaScript")).toBe(true);
  });

  it("falls back to discrimination when no language is stated", async () => {
    const c = await concept("some concept");
    const best = await make(c, "int x[10];", "c", 0.8);
    await make(c, "const x = [];", "javascript", 0.2);
    const picked = await selectItem(prisma, c, "functional");
    expect(picked?.id).toBe(best.id);
  });

  /** An item can carry its language inline in the prompt, leaving `codeLanguage` null. */
  it("treats an untagged item as unknown rather than neutral", () => {
    expect(isWrongLanguage({ codeLanguage: null }, "JavaScript")).toBe(true);
  });

  it("respects an explicit language-free tag", () => {
    expect(isWrongLanguage({ codeLanguage: "none" }, "JavaScript")).toBe(false);
  });

  it("prefers a matching item over an untagged one", async () => {
    const c = await concept("some concept");
    await make(c, null, null, 0.9);                       // untagged, high discrimination
    const want = await make(c, "const x = [];", "javascript", 0.1);
    const picked = await selectItem(prisma, c, "functional", [], { language: "JavaScript" });
    expect(picked?.id).toBe(want.id);
  });

  it("prefers a declared language-free item over another language", async () => {
    const c = await concept("some concept");
    const neutral = await make(c, null, "none", 0.1);
    await make(c, "int x[10];", "c", 0.9);
    const picked = await selectItem(prisma, c, "functional", [], { language: "JavaScript" });
    expect(picked?.id).toBe(neutral.id);
  });

  it("does not call a matching item wrong, in either casing", () => {
    expect(isWrongLanguage({ codeLanguage: "JavaScript" }, "javascript")).toBe(false);
    expect(isWrongLanguage({ codeLanguage: "python" }, "JavaScript")).toBe(true);
    // An untagged item is unknown, and a "C in the prompt text" item is untagged.
    expect(isWrongLanguage({ codeLanguage: null }, "JavaScript")).toBe(true);
    // No stated language means nothing to mismatch against.
    expect(isWrongLanguage({ codeLanguage: "c" }, null)).toBe(false);
  });
});
