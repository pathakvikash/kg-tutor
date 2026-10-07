import type { PrismaClient } from "@kg/db";
import { atLeast, type GoalDepth, type MasteryLevel } from "@kg/shared";

export interface TargetConcept {
  conceptId: string;
  requiredLevel: MasteryLevel;
  relevance: number;
  /** False when it entered only as a prerequisite of something wanted */
  goalFacing: boolean;
}

/** Depth sets the bar, so it lives on the goal rather than on every edge */
const REQUIRED: Record<GoalDepth, { goalFacing: MasteryLevel; support: MasteryLevel }> = {
  use: { goalFacing: "functional", support: "familiar" },
  debug: { goalFacing: "solid", support: "functional" },
  build: { goalFacing: "solid", support: "functional" },
};

export function honoursSoftEdges(depth: GoalDepth): boolean {
  return depth !== "use";
}

export interface ResolveGoalInput {
  prisma: PrismaClient;
  topicId: string;
  depth: GoalDepth;
  mastery: Map<string, MasteryLevel>;
}

/** Never stored, since one topic at two depths is two target sets */
export async function resolveGoal(input: ResolveGoalInput): Promise<TargetConcept[]> {
  const { prisma, topicId, depth, mastery } = input;
  const bar = REQUIRED[depth];

  const links = await prisma.topicConcept.findMany({
    where: { topicId, relation: "contains", concept: { deprecatedAt: null } },
  });

  const target = new Map<string, TargetConcept>();
  for (const l of links) {
    if (!l.direct) continue; // indirect links are prerequisites; the closure re-adds them
    target.set(l.conceptId, {
      conceptId: l.conceptId,
      requiredLevel: bar.goalFacing,
      relevance: l.relevance,
      goalFacing: true,
    });
  }

  const strengths = honoursSoftEdges(depth) ? ["hard", "soft"] : ["hard"];
  const queue = [...target.keys()];
  const visited = new Set<string>(queue);

  while (queue.length > 0) {
    const batch = queue.splice(0, 50);
    const edges = await prisma.edge.findMany({
      where: {
        dstId: { in: batch },
        type: "prerequisite_of",
        strength: { in: strengths as ("hard" | "soft")[] },
        retiredAt: null,
      },
    });
    for (const e of edges) {
      // Known already, so nothing behind it matters
      if (atLeast(mastery.get(e.srcId) ?? "unknown", bar.support)) continue;
      if (visited.has(e.srcId)) continue;
      visited.add(e.srcId);
      queue.push(e.srcId);
      if (!target.has(e.srcId)) {
        target.set(e.srcId, {
          conceptId: e.srcId,
          requiredLevel: bar.support,
          relevance: 0,
          goalFacing: false,
        });
      }
    }
  }

  return [...target.values()].filter(
    (t) => !atLeast(mastery.get(t.conceptId) ?? "unknown", t.requiredLevel),
  );
}
