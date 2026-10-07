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

/** Steps at the head of a plan that are treated as firm */
export const COMMITTED_HORIZON = 3;

export interface BuildPlanInput {
  prisma: PrismaClient;
  learnerId: string;
  goalId: string;
  thresholds?: Thresholds;
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
    // An empty milestone would hand out a completion for nothing
    if (malformed) continue;
    await tx.milestoneInstance.create({
      data: { planId, templateId: template.id, position, foldedForward: foldForward },
    });
    out.push({ templateId: template.id, position, foldedForward: foldForward });
    position++;
  }
  return out;
}

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

/** Spread this, don't rewrite it: `supersededAt: null` alone also matches abandoned goals */
export function activePlanWhere(learnerId: string) {
  return { learnerId, supersededAt: null, goal: { active: true } };
}
