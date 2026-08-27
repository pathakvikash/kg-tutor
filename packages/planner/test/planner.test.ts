import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  resolveGoal, orderTargetSet, buildPlan, describeDiff, loadMastery, reconcilePlan,
  activePlanWhere,
} from "../src/index.js";
import { prisma, reset, concept, hard, contains, setMastery } from "./helpers.js";
import type { GoalDepth, MasteryLevel } from "@kg/shared";

async function scenario(depth: GoalDepth = "use") {
  const topic = await prisma.topic.create({ data: { name: "JS", description: "" } });
  const learner = await prisma.learner.create({
    data: { email: `l${Math.round(performance.now() * 1000)}@x.test` },
  });

  // functions -> closures -> memoization, functions -> scope, variables behind functions.
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
    // Unreachable given the write-time DAG guard, but a hang is worse than a flagged order.
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

describe("reconcilePlan", () => {
  /** Mastery can arrive outside a lesson, so completion cannot be written only at lesson end. */
  it("completes steps whose mastery arrived without a lesson", async () => {
    const s = await scenario();
    const plan = await buildPlan({ prisma, learnerId: s.learner.id, goalId: s.goal.id });
    expect(plan.steps.length).toBeGreaterThan(1);

    const step = await prisma.planStep.findFirstOrThrow({
      where: { planId: plan.planId }, orderBy: { position: "asc" },
    });
    await setMastery(s.learner.id, step.conceptId, "solid");

    const { steps } = await reconcilePlan(prisma, s.learner.id);
    expect(steps).toContain(step.conceptId);
    const after = await prisma.planStep.findUniqueOrThrow({ where: { id: step.id } });
    expect(after.completedAt).not.toBeNull();
  });

  it("leaves a step alone when mastery is below what it requires", async () => {
    const s = await scenario();
    const plan = await buildPlan({ prisma, learnerId: s.learner.id, goalId: s.goal.id });
    const step = await prisma.planStep.findFirstOrThrow({
      where: { planId: plan.planId, requiredLevel: { not: "familiar" } },
      orderBy: { position: "asc" },
    });
    await setMastery(s.learner.id, step.conceptId, "familiar");

    const { steps } = await reconcilePlan(prisma, s.learner.id);
    expect(steps).not.toContain(step.conceptId);
  });

  it("is idempotent, so reconciling on every read cannot double-complete", async () => {
    const s = await scenario();
    const plan = await buildPlan({ prisma, learnerId: s.learner.id, goalId: s.goal.id });
    const step = await prisma.planStep.findFirstOrThrow({
      where: { planId: plan.planId }, orderBy: { position: "asc" },
    });
    await setMastery(s.learner.id, step.conceptId, "solid");

    const first = await reconcilePlan(prisma, s.learner.id);
    const stamped = await prisma.planStep.findUniqueOrThrow({ where: { id: step.id } });
    const second = await reconcilePlan(prisma, s.learner.id);

    expect(second.steps).toEqual([]);
    // The completion time is when it was earned, not when it was last looked at.
    const again = await prisma.planStep.findUniqueOrThrow({ where: { id: step.id } });
    expect(again.completedAt).toEqual(stamped.completedAt);
    expect(first.steps).toContain(step.conceptId);
  });

  /** An empty milestone is malformed. Satisfying it would award an unearned claim. */
  it("never completes a milestone that claims no concepts", async () => {
    const s = await scenario();
    const plan = await buildPlan({ prisma, learnerId: s.learner.id, goalId: s.goal.id });
    const template = await prisma.milestoneTemplate.create({
      data: { topicId: s.topic.id, claim: "You can do a thing nobody specified", ordering: 99 },
    });
    const instance = await prisma.milestoneInstance.create({
      data: { planId: plan.planId, templateId: template.id, position: 99 },
    });

    const { milestones } = await reconcilePlan(prisma, s.learner.id);
    expect(milestones).not.toContain(template.claim);
    const after = await prisma.milestoneInstance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(after.completedAt).toBeNull();
  });
});

describe("activePlanWhere", () => {
  /** An abandoned goal keeps its last plan un-superseded, so ordering by version can pick it. */
  it("ignores an un-superseded plan whose goal is no longer active", async () => {
    const s = await scenario();

    // An old goal that reached a higher version than the new one ever will.
    const oldTopic = await prisma.topic.create({ data: { name: "Old subject", description: "" } });
    const oldConcept = await concept("something else");
    await contains(oldTopic.id, oldConcept, true, 0.9);
    const oldGoal = await prisma.goal.create({
      data: { learnerId: s.learner.id, topicId: oldTopic.id, depth: "use", active: false },
    });
    let oldPlan = await buildPlan({ prisma, learnerId: s.learner.id, goalId: oldGoal.id });
    oldPlan = await buildPlan({ prisma, learnerId: s.learner.id, goalId: oldGoal.id });
    oldPlan = await buildPlan({ prisma, learnerId: s.learner.id, goalId: oldGoal.id });
    expect(oldPlan.version).toBe(3);

    const current = await buildPlan({ prisma, learnerId: s.learner.id, goalId: s.goal.id });
    expect(current.version).toBe(1);

    // Both are un-superseded, so the naive query has two candidates and takes v3.
    const naive = await prisma.plan.findFirst({
      where: { learnerId: s.learner.id, supersededAt: null },
      orderBy: { version: "desc" },
    });
    expect(naive?.id).toBe(oldPlan.planId);

    const scoped = await prisma.plan.findFirst({
      where: activePlanWhere(s.learner.id),
      orderBy: { version: "desc" },
    });
    expect(scoped?.id).toBe(current.planId);
  });

  it("reconciles the active goal's plan, not an abandoned one", async () => {
    const s = await scenario();
    const oldTopic = await prisma.topic.create({ data: { name: "Abandoned", description: "" } });
    const oldConcept = await concept("stale concept");
    await contains(oldTopic.id, oldConcept, true, 0.9);
    const oldGoal = await prisma.goal.create({
      data: { learnerId: s.learner.id, topicId: oldTopic.id, depth: "use", active: false },
    });
    const oldPlan = await buildPlan({ prisma, learnerId: s.learner.id, goalId: oldGoal.id });
    const current = await buildPlan({ prisma, learnerId: s.learner.id, goalId: s.goal.id });

    // Mastery on both, so reconciling either would have something to complete.
    await setMastery(s.learner.id, oldConcept, "solid");
    for (const st of current.steps) await setMastery(s.learner.id, st.conceptId, "solid");

    const { steps } = await reconcilePlan(prisma, s.learner.id);
    expect(steps).not.toContain(oldConcept);
    expect(steps.length).toBe(current.steps.length);

    const stale = await prisma.planStep.findFirst({ where: { planId: oldPlan.planId } });
    expect(stale?.completedAt).toBeNull();
  });
});
