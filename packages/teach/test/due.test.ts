import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { DEFAULT_THRESHOLDS } from "@kg/shared";
import { dueForReview, resolveMisconceptions } from "../src/due.js";
import { prisma, reset, concept, learner } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;

async function state(
  learnerId: string, conceptId: string,
  o: { mastery?: string; confidence?: number; ageDays?: number; source?: string } = {},
) {
  const ageDays = o.ageDays ?? 0;
  await prisma.learnerConceptState.create({
    data: {
      learnerId, conceptId,
      mastery: (o.mastery ?? "functional") as never,
      confidence: o.confidence ?? 0.9,
      source: (o.source ?? "assessed") as never,
      lastEvidenceAt: new Date(Date.now() - ageDays * DAY),
    },
  });
}

beforeEach(reset);
afterAll(async () => { await prisma.$disconnect(); });

describe("dueForReview", () => {
  it("is empty for a learner whose confidence is fresh", async () => {
    const l = await learner();
    await state(l, await concept("arrays"), { confidence: 0.95, ageDays: 0 });
    expect(await dueForReview(prisma, l)).toEqual([]);
  });

  it("surfaces a concept whose confidence has decayed past the floor", async () => {
    const l = await learner();
    const c = await concept("hash tables");
    await state(l, c, { mastery: "solid", confidence: 0.9, ageDays: 200 });
    const due = await dueForReview(prisma, l);
    expect(due).toHaveLength(1);
    expect(due[0]!.kind).toBe("decayed");
    expect(due[0]!.confidence).toBeLessThan(DEFAULT_THRESHOLDS.reprobeConfidenceFloor);
  });

  it("surfaces mastery that was inferred and never demonstrated", async () => {
    const l = await learner();
    await state(l, await concept("recursion"), { source: "inferred", confidence: 0.9, ageDays: 0 });
    const due = await dueForReview(prisma, l);
    expect(due.map((d) => d.kind)).toEqual(["inferred"]);
  });

  it("puts an unresolved wrong belief above everything else", async () => {
    const l = await learner();
    const decayed = await concept("queues");
    const wrong = await concept("pointers");
    await state(l, decayed, { mastery: "solid", confidence: 0.9, ageDays: 300 });
    await state(l, wrong, { confidence: 0.8, ageDays: 1 });
    await prisma.misconception.create({
      data: { learnerId: l, conceptId: wrong, belief: "a pointer holds a copy of the object" },
    });

    const due = await dueForReview(prisma, l);
    expect(due[0]!.kind).toBe("misconception");
    expect(due[0]!.belief).toContain("copy of the object");
    expect(due.map((d) => d.conceptName)).toEqual(["pointers", "queues"]);
  });

  it("ranks a belief seen repeatedly above one seen once", async () => {
    const l = await learner();
    const once = await concept("stacks");
    const twice = await concept("deques");
    for (const [c, n] of [[once, 1], [twice, 4]] as const) {
      await state(l, c, { confidence: 0.8, ageDays: 1 });
      await prisma.misconception.create({
        data: { learnerId: l, conceptId: c, belief: `wrong about ${c}`, observedCount: n },
      });
    }
    const due = await dueForReview(prisma, l);
    expect(due.map((d) => d.conceptName)).toEqual(["deques", "stacks"]);
  });

  it("reports a concept once, even with a belief and decay on it", async () => {
    const l = await learner();
    const c = await concept("tries");
    await state(l, c, { mastery: "solid", confidence: 0.9, ageDays: 400 });
    await prisma.misconception.create({
      data: { learnerId: l, conceptId: c, belief: "a trie stores whole strings per node" },
    });
    const due = await dueForReview(prisma, l);
    expect(due).toHaveLength(1);
    expect(due[0]!.kind).toBe("misconception");
  });

  it("ignores a deprecated concept", async () => {
    const l = await learner();
    const c = await concept("Arrays or Linked Lists");
    await state(l, c, { mastery: "solid", confidence: 0.9, ageDays: 400 });
    await prisma.concept.update({ where: { id: c }, data: { deprecatedAt: new Date() } });
    expect(await dueForReview(prisma, l)).toEqual([]);
  });

  it("honours the limit so a long queue does not become the whole page", async () => {
    const l = await learner();
    for (let i = 0; i < 6; i++) {
      await state(l, await concept(`c${i}`), { mastery: "solid", confidence: 0.9, ageDays: 300 });
    }
    expect(await dueForReview(prisma, l, { limit: 3 })).toHaveLength(3);
  });
});

describe("resolveMisconceptions", () => {
  it("clears open beliefs on the concept and leaves other concepts alone", async () => {
    const l = await learner();
    const a = await concept("bst");
    const b = await concept("heaps");
    await prisma.misconception.create({ data: { learnerId: l, conceptId: a, belief: "x" } });
    await prisma.misconception.create({ data: { learnerId: l, conceptId: b, belief: "y" } });

    expect(await resolveMisconceptions(prisma, l, a)).toBe(1);
    const open = await prisma.misconception.findMany({ where: { learnerId: l, resolvedAt: null } });
    expect(open.map((m) => m.conceptId)).toEqual([b]);
  });

  it("is a no-op when nothing is open", async () => {
    const l = await learner();
    expect(await resolveMisconceptions(prisma, l, await concept("graphs"))).toBe(0);
  });

  it("takes a resolved concept out of the queue", async () => {
    const l = await learner();
    const c = await concept("union-find");
    // Needs lastEvidenceAt, or confidence decays to 0 and the concept is due as "decayed"
    await prisma.learnerConceptState.create({
      data: {
        learnerId: l, conceptId: c, mastery: "functional", confidence: 0.85,
        source: "assessed", lastEvidenceAt: new Date(),
      },
    });
    await prisma.misconception.create({ data: { learnerId: l, conceptId: c, belief: "z" } });
    expect(await dueForReview(prisma, l)).toHaveLength(1);
    await resolveMisconceptions(prisma, l, c);
    expect(await dueForReview(prisma, l)).toEqual([]);
  });
});
