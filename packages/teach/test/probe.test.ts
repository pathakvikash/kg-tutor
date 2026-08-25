import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { selectProbes, trimToTimeBudget, type Probe } from "../src/probe.js";
import { prisma, reset, concept, learner, hardEdge } from "./helpers.js";

const FM = "The learner predicts a zero-delay timer runs before the current function returns.";
const DAY = 86_400_000;
const now = new Date("2026-08-26T00:00:00Z");
const ago = (d: number) => new Date(now.getTime() - d * DAY);

async function state(
  learnerId: string, conceptId: string,
  mastery: "unknown" | "familiar" | "functional" | "solid",
  confidence: number, lastEvidenceAt: Date,
  source: "assessed" | "inferred" | "taught" = "assessed",
) {
  await prisma.learnerConceptState.create({
    data: { learnerId, conceptId, mastery, confidence, lastEvidenceAt, source },
  });
}

beforeEach(reset);
afterAll(async () => { await prisma.$disconnect(); });

describe("selectProbes", () => {
  it("makes a decayed hard prerequisite a required readiness probe", async () => {
    const l = await learner();
    const pre = await concept("the event loop");
    const next = await concept("promises");
    await hardEdge(pre, next, FM);
    await state(l, pre, "functional", 0.9, ago(400));

    const probes = await selectProbes({
      prisma, learnerId: l, nextConceptId: next, reviewProbesUsedThisSession: 0, now,
    });
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ conceptId: pre, kind: "readiness", optional: false });
  });

  it("probes an inferred prerequisite even when its confidence is fresh", async () => {
    const l = await learner();
    const pre = await concept("the event loop");
    const next = await concept("promises");
    await hardEdge(pre, next, FM);
    // Never demonstrated — credited by backwards propagation, and it gates what is next.
    await state(l, pre, "solid", 0.45, now, "inferred");

    const probes = await selectProbes({
      prisma, learnerId: l, nextConceptId: next, reviewProbesUsedThisSession: 0, now,
    });
    expect(probes[0]?.kind).toBe("readiness");
    expect(probes[0]?.reason).toContain("inferred");
  });

  it("does not probe a prerequisite that is fresh and directly demonstrated", async () => {
    const l = await learner();
    const pre = await concept("the event loop");
    const next = await concept("promises");
    await hardEdge(pre, next, FM);
    await state(l, pre, "functional", 0.9, now);
    expect(await selectProbes({
      prisma, learnerId: l, nextConceptId: next, reviewProbesUsedThisSession: 0, now,
    })).toHaveLength(0);
  });

  it("does not probe something never seen — that is a teaching gap, not a probe", async () => {
    const l = await learner();
    const pre = await concept("the event loop");
    const next = await concept("promises");
    await hardEdge(pre, next, FM);
    expect(await selectProbes({
      prisma, learnerId: l, nextConceptId: next, reviewProbesUsedThisSession: 0, now,
    })).toHaveLength(0);
  });

  it("adds optional review probes for decayed concepts off the path", async () => {
    const l = await learner();
    const next = await concept("promises");
    const stale = await concept("closures");
    await state(l, stale, "solid", 0.9, ago(400));

    const probes = await selectProbes({
      prisma, learnerId: l, nextConceptId: next, reviewProbesUsedThisSession: 0, now,
    });
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ kind: "review", optional: true });
  });

  it("respects the per-session review budget", async () => {
    const l = await learner();
    const next = await concept("promises");
    for (const name of ["a", "b", "c", "d"]) {
      await state(l, await concept(name), "solid", 0.9, ago(400));
    }
    const two = await selectProbes({
      prisma, learnerId: l, nextConceptId: next, reviewProbesUsedThisSession: 0, now,
    });
    expect(two.filter((p) => p.kind === "review")).toHaveLength(2);

    const none = await selectProbes({
      prisma, learnerId: l, nextConceptId: next, reviewProbesUsedThisSession: 2, now,
    });
    expect(none.filter((p) => p.kind === "review")).toHaveLength(0);
  });

  it("orders required probes ahead of optional ones", async () => {
    const l = await learner();
    const pre = await concept("the event loop");
    const next = await concept("promises");
    await hardEdge(pre, next, FM);
    await state(l, pre, "functional", 0.9, ago(400));
    await state(l, await concept("closures"), "solid", 0.9, ago(500));

    const probes = await selectProbes({
      prisma, learnerId: l, nextConceptId: next, reviewProbesUsedThisSession: 0, now,
    });
    expect(probes.map((p) => p.kind)).toEqual(["readiness", "review"]);
  });
});

describe("trimToTimeBudget", () => {
  const p = (kind: "readiness" | "review", id: string): Probe => ({
    conceptId: id, kind, optional: kind === "review", reason: "", priority: 1,
  });

  it("drops review probes first when the session runs short", () => {
    const probes = [p("readiness", "a"), p("review", "b"), p("review", "c")];
    expect(trimToTimeBudget(probes, 1).map((x) => x.conceptId)).toEqual(["a"]);
    expect(trimToTimeBudget(probes, 2).map((x) => x.conceptId)).toEqual(["a", "b"]);
  });

  it("never drops a readiness probe, even over budget", () => {
    const probes = [p("readiness", "a"), p("readiness", "b"), p("review", "c")];
    // Skipping one would mean teaching into a gap, which is not a time saving.
    expect(trimToTimeBudget(probes, 1).map((x) => x.conceptId)).toEqual(["a", "b"]);
  });
});
