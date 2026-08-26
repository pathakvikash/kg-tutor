import type { PrismaClient } from "@kg/db";
import {
  DEFAULT_THRESHOLDS,
  trimMilestone,
  type GoalDepth,
  type MasteryLevel,
  type Thresholds,
} from "@kg/shared";
import { resolveGoal, honoursSoftEdges } from "./target.js";
import { orderTargetSet, type PrereqEdge } from "./order.js";

/** How many steps at the head of a plan are treated as firm. (09) */
export const COMMITTED_HORIZON = 3;

export interface BuildPlanInput {
  prisma: PrismaClient;
  learnerId: string;
  goalId: string;
  thresholds?: Thresholds;
  /** Explains what changed; produced by diffing against the superseded version. */
  revisionReason?: string;
}

export interface PlanSummary {
  planId: string;
  version: number;
  steps: { conceptId: string; position: number; committed: boolean; unlockCount: number }[];
  milestones: { templateId: string; position: number; foldedForward: boolean }[];
  revisionReason: string | null;
}

export async function loadMastery(
  prisma: PrismaClient,
  learnerId: string,
): Promise<Map<string, MasteryLevel>> {
  const rows = await prisma.learnerConceptState.findMany({ where: { learnerId } });
  return new Map(rows.map((r) => [r.conceptId, r.mastery]));
}

/**
 * Builds a plan and persists it as a new version. (09)
 *
 * Plans are stored rather than recomputed on demand because plan *growth* has to be
 * explainable: "we found a gap, two concepts added" needs a previous version to diff
 * against, and a progress bar that silently regresses reads as a bug. (08)
 */
export async function buildPlan(input: BuildPlanInput): Promise<PlanSummary> {
  const { prisma, learnerId, goalId } = input;
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;

  const goal = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } });
  const mastery = await loadMastery(prisma, learnerId);

  const target = await resolveGoal({
    prisma,
    topicId: goal.topicId,
    depth: goal.depth as GoalDepth,
    mastery,
  });

  const strengths: ("hard" | "soft")[] = honoursSoftEdges(goal.depth as GoalDepth)
    ? ["hard", "soft"]
    : ["hard"];
  const ids = target.map((x) => x.conceptId);
  const edges = await prisma.edge.findMany({
    where: {
      type: "prerequisite_of",
      strength: { in: strengths },
      retiredAt: null,
      srcId: { in: ids },
      dstId: { in: ids },
    },
  });

  const ordered = orderTargetSet({
    target,
    hardPrereqs: edges.map((e): PrereqEdge => ({
      srcId: e.srcId,
      dstId: e.dstId,
      strength: e.strength,
    })),
    mastery,
  });

  const previous = await prisma.plan.findFirst({
    where: { learnerId, goalId, supersededAt: null },
    include: { steps: true },
    orderBy: { version: "desc" },
  });

  const reason =
    input.revisionReason ??
    (previous
      ? describeDiff(previous.steps.map((s) => s.conceptId), ordered.map((s) => s.conceptId))
      : null);

  return prisma.$transaction(async (tx) => {
    if (previous) {
      await tx.plan.update({
        where: { id: previous.id },
        data: { supersededAt: new Date() },
      });
    }

    const plan = await tx.plan.create({
      data: {
        learnerId,
        goalId,
        version: (previous?.version ?? 0) + 1,
        revisionReason: reason,
      },
    });

    await tx.planStep.createMany({
      data: ordered.map((s, i) => ({
        planId: plan.id,
        conceptId: s.conceptId,
        position: i,
        requiredLevel: s.requiredLevel,
        committed: i < COMMITTED_HORIZON,
        unlockCount: s.unlockCount,
      })),
    });

    const milestones = await attachMilestones(tx, plan.id, goal.topicId, mastery, t);

    return {
      planId: plan.id,
      version: plan.version,
      steps: ordered.map((s, i) => ({
        conceptId: s.conceptId,
        position: i,
        committed: i < COMMITTED_HORIZON,
        unlockCount: s.unlockCount,
      })),
      milestones,
      revisionReason: reason,
    };
  });
}

/**
 * Milestone templates are trimmed against the learner, capability claim unchanged, and
 * a mostly-satisfied one folds forward rather than awarding a hollow completion. (18)
 */
async function attachMilestones(
  tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
  planId: string,
  topicId: string,
  mastery: Map<string, MasteryLevel>,
  t: Thresholds,
): Promise<{ templateId: string; position: number; foldedForward: boolean }[]> {
  const templates = await tx.milestoneTemplate.findMany({
    where: { topicId },
    include: { concepts: true },
    orderBy: { ordering: "asc" },
  });

  const out: { templateId: string; position: number; foldedForward: boolean }[] = [];
  let position = 0;
  for (const template of templates) {
    const { foldForward, malformed } = trimMilestone(
      template.concepts.map((c) => ({
        conceptId: c.conceptId,
        requiredLevel: c.requiredLevel,
      })),
      (id) => mastery.get(id) ?? "unknown",
      t,
    );
    // A malformed template is skipped rather than attached: an empty milestone on a
    // plan is a completion waiting to be handed out for nothing.
    if (malformed) continue;
    await tx.milestoneInstance.create({
      data: { planId, templateId: template.id, position, foldedForward: foldForward },
    });
    out.push({ templateId: template.id, position, foldedForward: foldForward });
    position++;
  }
  return out;
}

/**
 * The learner-facing explanation of a replan. Growth is stated plainly rather than
 * hidden, because an unexplained jump backwards is what destroys trust in progress. (08)
 */
export function describeDiff(before: string[], after: string[]): string {
  const wasThere = new Set(before);
  const isThere = new Set(after);
  const added = after.filter((id) => !wasThere.has(id));
  const removed = before.filter((id) => !isThere.has(id));

  const parts: string[] = [];
  if (added.length > 0) parts.push(`${added.length} concept${added.length === 1 ? "" : "s"} added`);
  if (removed.length > 0) {
    parts.push(`${removed.length} no longer needed`);
  }
  if (parts.length === 0) {
    const reordered = before.some((id, i) => after[i] !== id);
    return reordered ? "reordered; no concepts added or removed" : "no change";
  }
  return parts.join("; ");
}

/**
 * Where-clause for "the plan this learner is currently working through".
 *
 * `supersededAt: null` alone is not that plan, and reading it as such taught the wrong
 * subject. Superseding only happens between versions of the SAME goal, so every goal a
 * learner ever abandons leaves its last plan un-superseded forever. One learner had eight
 * such plans and `orderBy: { version: "desc" }` picked the highest version among them —
 * an abandoned Asynchronous JavaScript goal at v3 — over the Data Structures plan at v1
 * they had just built. They finished a 36-concept assessment and were taught
 * higher-order functions.
 *
 * The active goal is what disambiguates, and `activeGoalFor` keeps exactly one. Spread
 * this rather than rewriting the clause, so the next reader inherits the constraint
 * instead of rediscovering it.
 */
export function activePlanWhere(learnerId: string) {
  return { learnerId, supersededAt: null, goal: { active: true } };
}
