import { atLeast, type MasteryLevel } from "@kg/shared";
import type { TargetConcept } from "./target.js";

export interface PrereqEdge {
  srcId: string;
  dstId: string;
  strength: "hard" | "soft";
}

export interface OrderInput {
  target: TargetConcept[];
  hardPrereqs: PrereqEdge[];
  mastery: Map<string, MasteryLevel>;
  /** Concepts already placed earlier in this plan count as satisfied downstream. */
  placed?: Set<string>;
}

export interface OrderedStep {
  conceptId: string;
  requiredLevel: MasteryLevel;
  /** Target-set concepts this one unblocks — the primary objective. (09) */
  unlockCount: number;
  reasonCodes: string[];
}

/** Hard prerequisites met, either by existing mastery or by an earlier plan step. */
function isEligible(
  conceptId: string,
  prereqsOf: Map<string, string[]>,
  mastery: Map<string, MasteryLevel>,
  satisfied: Set<string>,
  inTarget: Set<string>,
): boolean {
  for (const p of prereqsOf.get(conceptId) ?? []) {
    if (satisfied.has(p)) continue;
    // A prerequisite outside the target set was already filtered out as known.
    if (!inTarget.has(p)) continue;
    if (atLeast(mastery.get(p) ?? "unknown", "functional")) continue;
    return false;
  }
  return true;
}

/** Counts unlocks transitively within the target set; direct successors undercount badly. */
function transitiveUnlocks(
  conceptId: string,
  dependents: Map<string, string[]>,
  inTarget: Set<string>,
): number {
  const seen = new Set<string>();
  const stack = [...(dependents.get(conceptId) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next) || !inTarget.has(next)) continue;
    seen.add(next);
    stack.push(...(dependents.get(next) ?? []));
  }
  return seen.size;
}

/** Ordered by unlock count, except the first step, which prefers a goal-relevant win. (09) */
export function orderTargetSet(input: OrderInput): OrderedStep[] {
  const inTarget = new Set(input.target.map((t) => t.conceptId));
  const byId = new Map(input.target.map((t) => [t.conceptId, t]));

  const prereqsOf = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const e of input.hardPrereqs) {
    if (!inTarget.has(e.dstId)) continue;
    prereqsOf.set(e.dstId, [...(prereqsOf.get(e.dstId) ?? []), e.srcId]);
    dependents.set(e.srcId, [...(dependents.get(e.srcId) ?? []), e.dstId]);
  }

  const satisfied = new Set(input.placed ?? []);
  const remaining = new Set(inTarget);
  const out: OrderedStep[] = [];
  let previous: string | undefined;

  while (remaining.size > 0) {
    const eligible = [...remaining].filter((id) =>
      isEligible(id, prereqsOf, input.mastery, satisfied, inTarget),
    );

    // A cycle makes nothing eligible; degrade to a usable order rather than loop forever.
    const pool = eligible.length > 0 ? eligible : [...remaining];
    const stalled = eligible.length === 0;

    const scored = pool.map((id) => {
      const t = byId.get(id)!;
      const unlockCount = transitiveUnlocks(id, dependents, inTarget);
      const coherent = previous !== undefined && (dependents.get(previous) ?? []).includes(id);
      return { id, t, unlockCount, coherent };
    });

    let pick: (typeof scored)[number];
    if (out.length === 0) {
      // First-step exception: a visible win beats an optimal one.
      const win = scored
        .filter((s) => s.t.goalFacing && s.t.relevance > 0)
        .sort((a, b) => b.t.relevance - a.t.relevance || b.unlockCount - a.unlockCount)[0];
      pick =
        win ??
        scored.sort((a, b) => b.unlockCount - a.unlockCount || b.t.relevance - a.t.relevance)[0]!;
    } else {
      pick = scored.sort(
        (a, b) =>
          b.unlockCount - a.unlockCount ||
          Number(b.coherent) - Number(a.coherent) ||
          b.t.relevance - a.t.relevance ||
          a.id.localeCompare(b.id),
      )[0]!;
    }

    const reasonCodes: string[] = [];
    if (out.length === 0 && pick.t.goalFacing && pick.t.relevance > 0) {
      reasonCodes.push("first_step_visible_win");
    }
    if (pick.unlockCount > 0) reasonCodes.push(`unlocks_${pick.unlockCount}`);
    if (pick.coherent) reasonCodes.push("chain_coherence");
    if (!pick.t.goalFacing) reasonCodes.push("prerequisite");
    if (stalled) reasonCodes.push("degraded_no_eligible_concept");

    out.push({
      conceptId: pick.id,
      requiredLevel: pick.t.requiredLevel,
      unlockCount: pick.unlockCount,
      reasonCodes,
    });
    remaining.delete(pick.id);
    satisfied.add(pick.id);
    previous = pick.id;
  }

  return out;
}
