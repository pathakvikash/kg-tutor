import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { resolveGoal, orderTargetSet, buildPlan, describeDiff, loadMastery } from "../src/index.js";
import { prisma, reset, concept, hard, contains, setMastery } from "./helpers.js";
import type { GoalDepth, MasteryLevel } from "@kg/shared";

async function scenario(depth: GoalDepth = "use") {
  const topic = await prisma.topic.create({ data: { name: "JS", description: "" } });
  const learner = await prisma.learner.create({
    data: { email: `l${Math.round(performance.now() * 1000)}@x.test` },
  });

  // functions -> closures -> memoization, and functions -> scope.
  // `variables` sits behind functions, two levels from anything goal-facing.
  const variables = await concept("variables");
  const functions = await concept("functions");
  const closures = await concept("closures");
  const scope = await concept("scope");
  const memo = await concept("memoization");

  await hard(variables, functions);
  await hard(functions, closures);
  await hard(functions, scope);
  await hard(closures, memo);

  // Only closures and memoization are what the topic is actually about.
  await contains(topic.id, closures, true, 0.9);
  await contains(topic.id, memo, true, 0.4);

  const goal = await prisma.goal.create({
    data: { learnerId: learner.id, topicId: topic.id, depth, active: true },
  });
  return { topic, learner, goal, variables, functions, closures, scope, memo };
}

beforeEach(reset);
afterAll(async () => { await prisma.$disconnect(); });

describe("resolveGoal", () => {
  it("pulls in prerequisites of goal-facing concepts", async () => {
    const s = await scenario();
    const target = await resolveGoal({
      prisma, topicId: s.topic.id, depth: "use", mastery: new Map(),
    });
    const ids = target.map((t) => t.conceptId).sort();
    expect(ids).toEqual([s.variables, s.functions, s.closures, s.memo].sort());
    // `scope` is a prerequisite of nothing the goal wants, so it stays out.
    expect(ids).not.toContain(s.scope);
  });

  it("stops the backwards walk at what the learner already knows", async () => {
    const s = await scenario();
    const mastery = new Map<string, MasteryLevel>([[s.functions, "functional"]]);
    const target = await resolveGoal({
      prisma, topicId: s.topic.id, depth: "use", mastery,
    });
    const ids = target.map((t) => t.conceptId);
    expect(ids).toContain(s.closures);
    expect(ids).not.toContain(s.functions); // known
    expect(ids).not.toContain(s.variables); // behind something known
  });

  it("raises the bar for build compared with use", async () => {
    const use = await resolveGoal({
      prisma, topicId: (await scenario("use")).topic.id, depth: "use", mastery: new Map(),
    });
    await reset();
    const s = await scenario("build");
    const build = await resolveGoal({
      prisma, topicId: s.topic.id, depth: "build", mastery: new Map(),
    });
    const goalFacing = (xs: typeof use) => xs.filter((x) => x.goalFacing)[0]?.requiredLevel;
    expect(goalFacing(use)).toBe("functional");
    expect(goalFacing(build)).toBe("solid");
  });

  it("drops concepts already at the required level", async () => {
    const s = await scenario();
    const mastery = new Map<string, MasteryLevel>([[s.closures, "solid"]]);
    const target = await resolveGoal({ prisma, topicId: s.topic.id, depth: "use", mastery });
    expect(target.map((t) => t.conceptId)).not.toContain(s.closures);
  });
});

describe("orderTargetSet", () => {
  it("never places a concept before its hard prerequisite", async () => {
    const s = await scenario();
    const target = await resolveGoal({
      prisma, topicId: s.topic.id, depth: "use", mastery: new Map(),
    });
    const edges = await prisma.edge.findMany({ where: { type: "prerequisite_of" } });
    const order = orderTargetSet({
      target,
      hardPrereqs: edges.map((e) => ({ srcId: e.srcId, dstId: e.dstId, strength: e.strength })),
      mastery: new Map(),
    });
    const at = (id: string) => order.findIndex((o) => o.conceptId === id);
    expect(at(s.variables)).toBeLessThan(at(s.functions));
    expect(at(s.functions)).toBeLessThan(at(s.closures));
    expect(at(s.closures)).toBeLessThan(at(s.memo));
  });

  it("counts unlocks transitively, not just direct successors", async () => {
    const s = await scenario();
    const target = await resolveGoal({
      prisma, topicId: s.topic.id, depth: "use", mastery: new Map(),
    });
    const edges = await prisma.edge.findMany({ where: { type: "prerequisite_of" } });
    const order = orderTargetSet({
      target,
      hardPrereqs: edges.map((e) => ({ srcId: e.srcId, dstId: e.dstId, strength: e.strength })),
      mastery: new Map(),
    });
    // variables -> functions -> closures -> memoization: three downstream, not one.
    expect(order.find((o) => o.conceptId === s.variables)?.unlockCount).toBe(3);
    expect(order.find((o) => o.conceptId === s.memo)?.unlockCount).toBe(0);
  });

  it("records why each step was chosen", async () => {
    const s = await scenario();
    const target = await resolveGoal({
      prisma, topicId: s.topic.id, depth: "use", mastery: new Map(),
    });
    const edges = await prisma.edge.findMany({ where: { type: "prerequisite_of" } });
    const order = orderTargetSet({
      target,
      hardPrereqs: edges.map((e) => ({ srcId: e.srcId, dstId: e.dstId, strength: e.strength })),
      mastery: new Map(),
    });
    expect(order[0]?.reasonCodes.some((r) => r.startsWith("unlocks_"))).toBe(true);
    expect(order.find((o) => o.conceptId === s.variables)?.reasonCodes).toContain("prerequisite");
  });

  it("degrades to a usable order instead of looping when nothing is eligible", () => {
    // Should be unreachable given the write-time DAG guard, but a stalled planner that
    // hangs is worse than one that emits a flagged order.
    const order = orderTargetSet({
      target: [
        { conceptId: "a", requiredLevel: "functional", relevance: 0, goalFacing: true },
        { conceptId: "b", requiredLevel: "functional", relevance: 0, goalFacing: true },
      ],
      hardPrereqs: [
        { srcId: "a", dstId: "b", strength: "hard" },
        { srcId: "b", dstId: "a", strength: "hard" },
      ],
      mastery: new Map(),
    });
    expect(order).toHaveLength(2);
    expect(order[0]?.reasonCodes).toContain("degraded_no_eligible_concept");
  });
});

describe("buildPlan", () => {
  it("persists steps, commits only the head, and records unlock counts", async () => {
    const s = await scenario();
    const plan = await buildPlan({ prisma, learnerId: s.learner.id, goalId: s.goal.id });
    expect(plan.version).toBe(1);
    expect(plan.steps.filter((x) => x.committed)).toHaveLength(3);
    expect(plan.steps.length).toBeGreaterThan(3);

    const persisted = await prisma.planStep.findMany({
      where: { planId: plan.planId }, orderBy: { position: "asc" },
    });
    expect(persisted.map((p) => p.position)).toEqual(plan.steps.map((s2) => s2.position));
  });

  it("supersedes the previous version and explains what changed", async () => {
    const s = await scenario();
    const first = await buildPlan({ prisma, learnerId: s.learner.id, goalId: s.goal.id });

    // The learner turns out to know functions, so its prerequisites leave the plan.
    await setMastery(s.learner.id, s.functions, "functional");
    const second = await buildPlan({ prisma, learnerId: s.learner.id, goalId: s.goal.id });

    expect(second.version).toBe(2);
    expect(second.revisionReason).toContain("no longer needed");
    expect(second.steps.length).toBeLessThan(first.steps.length);

    const old = await prisma.plan.findUniqueOrThrow({ where: { id: first.planId } });
    expect(old.supersededAt).not.toBeNull();
    const live = await prisma.plan.findMany({
      where: { learnerId: s.learner.id, supersededAt: null },
    });
    expect(live).toHaveLength(1);
  });

  it("trims milestones against the learner and folds a mostly-satisfied one forward", async () => {
    const s = await scenario();
    const template = await prisma.milestoneTemplate.create({
      data: { topicId: s.topic.id, claim: "You can write a closure that captures state", ordering: 0 },
    });
    for (const id of [s.functions, s.closures, s.memo]) {
      await prisma.milestoneConcept.create({
        data: { templateId: template.id, conceptId: id, requiredLevel: "functional" },
      });
    }

    const fresh = await buildPlan({ prisma, learnerId: s.learner.id, goalId: s.goal.id });
    expect(fresh.milestones[0]?.foldedForward).toBe(false);

    for (const id of [s.functions, s.closures, s.memo]) {
      await setMastery(s.learner.id, id, "functional");
    }
    const later = await buildPlan({ prisma, learnerId: s.learner.id, goalId: s.goal.id });
    expect(later.milestones[0]?.foldedForward).toBe(true);
  });

  it("loads mastery for the right learner only", async () => {
    const s = await scenario();
    const other = await prisma.learner.create({ data: { email: "other@x.test" } });
    await setMastery(other.id, s.closures, "solid");
    expect((await loadMastery(prisma, s.learner.id)).size).toBe(0);
    expect((await loadMastery(prisma, other.id)).get(s.closures)).toBe("solid");
  });
});

describe("describeDiff", () => {
  it("states growth plainly rather than hiding it", () => {
    expect(describeDiff(["a", "b"], ["a", "b", "c", "d"])).toBe("2 concepts added");
    expect(describeDiff(["a", "b", "c"], ["a"])).toBe("2 no longer needed");
    expect(describeDiff(["a", "b"], ["a", "c"])).toBe("1 concept added; 1 no longer needed");
    expect(describeDiff(["a", "b"], ["a", "b"])).toBe("no change");
    expect(describeDiff(["a", "b"], ["b", "a"])).toBe("reordered; no concepts added or removed");
  });
});
