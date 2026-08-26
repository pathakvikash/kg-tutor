import type { PrismaClient } from "@kg/db";
import { atLeast, type GoalDepth, type MasteryLevel } from "@kg/shared";

export interface TargetConcept {
  conceptId: string;
  requiredLevel: MasteryLevel;
  /** How central to the goal topic — the relevance tie-breaker. (09) */
  relevance: number;
  /** False when it entered only as a prerequisite of something the goal wanted. */
  goalFacing: boolean;
}

/**
 * Depth sets the bar, and it is the reason depth lives on the goal rather than on every
 * edge. (03, 08)
 *
 * `use` wants working knowledge of the goal-facing concepts. `build` wants solid
 * understanding, which is also what pulls soft prerequisites into scope.
 */
const REQUIRED: Record<GoalDepth, { goalFacing: MasteryLevel; support: MasteryLevel }> = {
  use: { goalFacing: "functional", support: "familiar" },
  debug: { goalFacing: "solid", support: "functional" },
  build: { goalFacing: "solid", support: "functional" },
};

/** `build` and `debug` honour soft prerequisites; `use` does not. (03) */
export function honoursSoftEdges(depth: GoalDepth): boolean {
  return depth !== "use";
}

export interface ResolveGoalInput {
  prisma: PrismaClient;
  topicId: string;
  depth: GoalDepth;
  /** Current mastery, used as the recursion floor. (04) */
  mastery: Map<string, MasteryLevel>;
}

/**
 * A goal resolves into an explicit target set at plan time — never stored on the Topic,
 * because two learners aiming at the same topic with different depths must get
 * different targets. (08)
 *
 * The backwards closure stops at concepts the learner already knows: the floor is the
 * learner, not the graph. (04)
 */
export async function resolveGoal(input: ResolveGoalInput): Promise<TargetConcept[]> {
  const { prisma, topicId, depth, mastery } = input;
  const bar = REQUIRED[depth];

  // A deprecated concept is one the graph has decided is not a concept — usually a
  // compound that has since been split. The resolver and the graph view already exclude
  // them; the planner did not, so deprecating one changed nothing about what got taught.
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
      // Stop the branch here: they already know it, so nothing behind it matters. (04)
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

  // Drop anything already at the required level — nothing left to teach there.
  return [...target.values()].filter(
    (t) => !atLeast(mastery.get(t.conceptId) ?? "unknown", t.requiredLevel),
  );
}
