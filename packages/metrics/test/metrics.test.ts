import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@kg/db";
import {
  graphReuseRate, wastedTeaching, crossSessionPersistence, costPerOutcome, compareArms,
} from "../src/index.js";

const prisma = new PrismaClient();
const DAY = 86_400_000;

async function reset() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "UsageRecord", "EvidenceEvent", "LearnerConceptState", "MilestoneInstance",
      "Plan", "Goal", "Session", "ConceptProposal", "TopicConcept", "Edge",
      "ConceptAlias", "Concept", "Topic", "Learner" RESTART IDENTITY CASCADE`,
  );
}
let n = 0;
const concept = async (name: string) =>
  (await prisma.concept.create({ data: { canonicalName: name, sense: `s${n++}` } })).id;
const learner = async () =>
  (await prisma.learner.create({ data: { email: `m${n++}@x.test` } })).id;

beforeEach(reset);
afterAll(async () => { await prisma.$disconnect(); });

describe("graphReuseRate", () => {
  it("is zero on an empty graph rather than dividing by zero", async () => {
    expect(await graphReuseRate(prisma)).toMatchObject({ proposals: 0, reuseRate: 0 });
  });

  it("measures the fraction of proposals that bound to existing concepts", async () => {
    const c = await concept("python");
    for (const outcome of ["created", "bound", "bound", "bound"] as const) {
      await prisma.conceptProposal.create({
        data: { proposedName: "python", proposedSense: "s", outcome, resolvedToId: c },
      });
    }
    const r = await graphReuseRate(prisma);
    expect(r).toMatchObject({ proposals: 4, created: 1, bound: 3 });
    expect(r.reuseRate).toBeCloseTo(0.75, 5);
  });

  it("ignores unresolved proposals", async () => {
    await prisma.conceptProposal.create({ data: { proposedName: "x", proposedSense: "s" } });
    expect((await graphReuseRate(prisma)).proposals).toBe(0);
  });
});

describe("wastedTeaching", () => {
  it("counts a first-contact transfer as something they already knew", async () => {
    const l = await learner();
    const c = await concept("closures");
    await prisma.evidenceEvent.create({ data: { learnerId: l, conceptId: c, kind: "transferred" } });
    const w = await wastedTeaching(prisma, l);
    expect(w).toMatchObject({ attempts: 1, alreadyKnew: 1 });
  });

  it("does not count it when the learner was taught first", async () => {
    const l = await learner();
    const c = await concept("closures");
    await prisma.evidenceEvent.create({ data: { learnerId: l, conceptId: c, kind: "restated" } });
    await prisma.evidenceEvent.create({ data: { learnerId: l, conceptId: c, kind: "transferred" } });
    expect((await wastedTeaching(prisma, l)).alreadyKnew).toBe(0);
  });

  it("counts teaching into a prerequisite gap", async () => {
    const l = await learner();
    const c = await concept("promises");
    await prisma.evidenceEvent.create({
      data: {
        learnerId: l, conceptId: c, kind: "failed_check",
        detail: { diagnosis: "missing_prerequisite" },
      },
    });
    expect((await wastedTeaching(prisma, l)).taughtIntoGap).toBe(1);
  });
});

describe("crossSessionPersistence", () => {
  it("only counts re-probes after a real gap", async () => {
    const l = await learner();
    const c = await concept("promises");
    const now = Date.now();
    await prisma.evidenceEvent.create({
      data: { learnerId: l, conceptId: c, kind: "applied", createdAt: new Date(now - 30 * DAY) },
    });
    await prisma.evidenceEvent.create({
      data: { learnerId: l, conceptId: c, kind: "reprobe_pass", createdAt: new Date(now) },
    });
    const r = await crossSessionPersistence(prisma, 7);
    expect(r).toMatchObject({ concepts: 1, held: 1 });
    // Same evidence inside the window should not count at all.
    expect((await crossSessionPersistence(prisma, 60)).concepts).toBe(0);
  });

  it("records a failed re-probe as not held", async () => {
    const l = await learner();
    const c = await concept("promises");
    const now = Date.now();
    await prisma.evidenceEvent.create({
      data: { learnerId: l, conceptId: c, kind: "applied", createdAt: new Date(now - 30 * DAY) },
    });
    await prisma.evidenceEvent.create({
      data: { learnerId: l, conceptId: c, kind: "reprobe_fail", createdAt: new Date(now) },
    });
    expect(await crossSessionPersistence(prisma, 7)).toMatchObject({ concepts: 1, held: 0 });
  });
});

describe("costPerOutcome", () => {
  it("returns null rather than infinity when nothing has been mastered", async () => {
    await prisma.usageRecord.create({
      data: { purpose: "expand", tier: "strong", model: "m", costUsd: 1.5 },
    });
    const r = await costPerOutcome(prisma);
    expect(r.totalCostUsd).toBeCloseTo(1.5, 5);
    expect(r.costPerConceptMastered).toBeNull();
  });

  it("divides by verified outcomes and breaks cost down by purpose", async () => {
    const l = await learner();
    const c1 = await concept("a");
    const c2 = await concept("b");
    for (const [purpose, cost] of [["expand", 0.8], ["grade", 0.2], ["grade", 0.2]] as const) {
      await prisma.usageRecord.create({
        data: { purpose, tier: "small", model: "m", costUsd: cost },
      });
    }
    for (const id of [c1, c2]) {
      await prisma.learnerConceptState.create({
        data: { learnerId: l, conceptId: id, mastery: "functional", confidence: 0.8 },
      });
    }
    const r = await costPerOutcome(prisma);
    expect(r.conceptsMastered).toBe(2);
    expect(r.costPerConceptMastered).toBeCloseTo(0.6, 5);
    expect(r.byPurpose[0]).toMatchObject({ purpose: "expand", calls: 1 });
  });

  it("does not count familiar as mastered", async () => {
    const l = await learner();
    const c = await concept("a");
    await prisma.learnerConceptState.create({
      data: { learnerId: l, conceptId: c, mastery: "familiar", confidence: 0.5 },
    });
    expect((await costPerOutcome(prisma)).conceptsMastered).toBe(0);
  });
});

describe("compareArms", () => {
  it("separates the graph arm from the baseline", async () => {
    for (const [variant, count] of [["graph", 3], ["baseline", 1]] as const) {
      for (let i = 0; i < count; i++) {
        const l = await learner();
        await prisma.session.create({ data: { learnerId: l, variant } });
        const c = await concept(`${variant}-${i}`);
        await prisma.learnerConceptState.create({
          data: { learnerId: l, conceptId: c, mastery: "functional", confidence: 0.8 },
        });
      }
    }
    const arms = await compareArms(prisma);
    expect(arms.map((a) => a.variant).sort()).toEqual(["baseline", "graph"]);
    expect(arms.find((a) => a.variant === "graph")?.learners).toBe(3);
    expect(arms.every((a) => a.masteredPerLearner === 1)).toBe(true);
  });
});
