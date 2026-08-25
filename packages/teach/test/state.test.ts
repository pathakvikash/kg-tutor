import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { recordEvidence, propagateBackwards, conceptsNeedingReprobe } from "../src/state.js";
import { prisma, reset, concept, learner, hardEdge } from "./helpers.js";

const FM = "The learner predicts a zero-delay timer runs before the current function returns.";
const DAY = 86_400_000;

beforeEach(reset);
afterAll(async () => { await prisma.$disconnect(); });

describe("recordEvidence", () => {
  it("promotes along the ladder and always appends an event", async () => {
    const l = await learner();
    const c = await concept("closures");

    expect((await recordEvidence(prisma, { learnerId: l, conceptId: c, kind: "restated" })).after.mastery)
      .toBe("familiar");
    expect((await recordEvidence(prisma, { learnerId: l, conceptId: c, kind: "applied" })).after.mastery)
      .toBe("functional");
    expect((await recordEvidence(prisma, { learnerId: l, conceptId: c, kind: "transferred" })).after.mastery)
      .toBe("solid");

    expect(await prisma.evidenceEvent.count({ where: { conceptId: c } })).toBe(3);
  });

  it("does not demote on a first failure — it lowers confidence and queues a re-probe", async () => {
    const l = await learner();
    const c = await concept("closures");
    await recordEvidence(prisma, { learnerId: l, conceptId: c, kind: "applied" });

    const fail = await recordEvidence(prisma, { learnerId: l, conceptId: c, kind: "failed_check" });
    expect(fail.after.mastery).toBe("functional");
    expect(fail.demoted).toBe(false);
    expect(fail.reprobeQueued).toBe(true);
    expect(fail.after.confidence).toBeLessThanOrEqual(0.25);
  });

  it("demotes only once a re-probe confirms the failure", async () => {
    const l = await learner();
    const c = await concept("closures");
    await recordEvidence(prisma, { learnerId: l, conceptId: c, kind: "applied" });
    await recordEvidence(prisma, { learnerId: l, conceptId: c, kind: "failed_check" });

    const confirmed = await recordEvidence(prisma, { learnerId: l, conceptId: c, kind: "reprobe_fail" });
    expect(confirmed.demoted).toBe(true);
    expect(confirmed.after.mastery).toBe("familiar");
  });

  it("keeps a self-reported skip at low confidence so it gets re-probed", async () => {
    const l = await learner();
    const c = await concept("promises");
    const r = await recordEvidence(prisma, {
      learnerId: l, conceptId: c, kind: "self_reported_skip",
    });
    expect(r.after.mastery).toBe("familiar");
    expect(r.after.confidence).toBeLessThan(0.3);
    const row = await prisma.learnerConceptState.findFirstOrThrow({ where: { conceptId: c } });
    expect(row.source).toBe("self_reported");
  });
});

describe("propagateBackwards", () => {
  it("credits hard prerequisites when a downstream concept is learned", async () => {
    const l = await learner();
    const fns = await concept("functions");
    const closures = await concept("closures");
    await hardEdge(fns, closures, FM);

    const touched = await propagateBackwards(prisma, l, closures);
    expect(touched).toEqual([fns]);

    const state = await prisma.learnerConceptState.findFirstOrThrow({ where: { conceptId: fns } });
    expect(state.mastery).toBe("solid");
    expect(state.source).toBe("inferred");
    // Inferred, so deliberately less trusted than the same level directly demonstrated.
    expect(state.confidence).toBeLessThan(0.6);
  });

  it("never overwrites direct evidence with inference", async () => {
    const l = await learner();
    const fns = await concept("functions");
    const closures = await concept("closures");
    await hardEdge(fns, closures, FM);

    await recordEvidence(prisma, { learnerId: l, conceptId: fns, kind: "applied" });
    const touched = await propagateBackwards(prisma, l, closures);
    expect(touched).toEqual([]);

    const state = await prisma.learnerConceptState.findFirstOrThrow({ where: { conceptId: fns } });
    expect(state.source).toBe("taught");
  });

  it("does not propagate across soft edges", async () => {
    const l = await learner();
    const a = await concept("history of js");
    const b = await concept("closures");
    await prisma.edge.create({
      data: { srcId: a, dstId: b, type: "prerequisite_of", strength: "soft" },
    });
    expect(await propagateBackwards(prisma, l, b)).toEqual([]);
  });
});

describe("conceptsNeedingReprobe", () => {
  it("surfaces high mastery whose confidence has decayed, worst first", async () => {
    const l = await learner();
    const stale = await concept("promises");
    const fresh = await concept("closures");
    const now = new Date("2026-08-26T00:00:00Z");

    await recordEvidence(prisma, {
      learnerId: l, conceptId: stale, kind: "applied", now: new Date(now.getTime() - 400 * DAY),
    });
    await recordEvidence(prisma, { learnerId: l, conceptId: fresh, kind: "applied", now });

    const due = await conceptsNeedingReprobe(prisma, l, now);
    expect(due.map((d) => d.conceptId)).toEqual([stale]);
  });

  it("ignores low mastery — that is a teaching problem, not a re-probe", async () => {
    const l = await learner();
    const c = await concept("closures");
    const old = new Date(Date.now() - 400 * DAY);
    await recordEvidence(prisma, { learnerId: l, conceptId: c, kind: "restated", now: old });
    expect(await conceptsNeedingReprobe(prisma, l)).toEqual([]);
  });
});
