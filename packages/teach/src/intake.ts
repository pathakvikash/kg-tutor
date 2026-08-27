import type { PrismaClient } from "@kg/db";
import { DEFAULT_THRESHOLDS, type MasteryLevel, type Thresholds } from "@kg/shared";

// Intake targets the fewest questions that make the first teaching steps defensible. (07)

export interface Chain {
  /** Ordered foundation → goal-facing. */
  ids: string[];
  /** Binary-search window into `ids`: everything below `lo` is believed known. */
  lo: number;
  hi: number;
}

export interface IntakeState {
  chains: Chain[];
  asked: { conceptId: string; chainIndex: number; correct: boolean }[];
}

export interface ProbeChoice {
  conceptId: string;
  chainIndex: number;
  /** Where in its chain, so the UI can say why this question is being asked. */
  position: number;
  chainLength: number;
}

/** Longest-path chains through the prerequisite graph; chains may overlap on shared foundations. */
export function buildChains(
  conceptIds: string[],
  edges: { srcId: string; dstId: string }[],
): string[][] {
  const inTopic = new Set(conceptIds);
  const parents = new Map<string, string[]>();
  const hasChild = new Set<string>();
  for (const e of edges) {
    if (!inTopic.has(e.srcId) || !inTopic.has(e.dstId)) continue;
    parents.set(e.dstId, [...(parents.get(e.dstId) ?? []), e.srcId]);
    hasChild.add(e.srcId);
  }

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // soft cycles are possible; hard ones are not
    visiting.add(id);
    const ps = parents.get(id) ?? [];
    const d = ps.length === 0 ? 0 : Math.max(...ps.map(depthOf)) + 1;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of conceptIds) depthOf(id);

  // A leaf here means "nothing in the topic depends on it" — the end of a chain.
  const leaves = conceptIds.filter((id) => !hasChild.has(id));
  const chains: string[][] = [];
  for (const leaf of leaves.length > 0 ? leaves : conceptIds) {
    const path: string[] = [leaf];
    let cursor = leaf;
    const guard = new Set([leaf]);
    for (;;) {
      const ps = (parents.get(cursor) ?? []).filter((p) => !guard.has(p));
      if (ps.length === 0) break;
      const deepest = ps.reduce((a, b) => (depthOf(a) >= depthOf(b) ? a : b));
      path.push(deepest);
      guard.add(deepest);
      cursor = deepest;
    }
    chains.push(path.reverse());
  }
  // A single-concept chain teaches the probe nothing, unless it is all the topic has.
  const searchable = chains.filter((c) => c.length > 1);
  return searchable.length > 0 ? searchable : chains;
}

export function initialState(chains: string[][]): IntakeState {
  return {
    chains: chains.map((ids) => ({ ids, lo: 0, hi: ids.length - 1 })),
    asked: [],
  };
}

/** Binary search within a chain, round-robin across chains, so breadth comes first. */
export function nextProbe(
  state: IntakeState,
  t: Thresholds = DEFAULT_THRESHOLDS,
): ProbeChoice | null {
  if (state.asked.length >= t.maxInitialProbes) return null;

  const alreadyAsked = new Set(state.asked.map((a) => a.conceptId));
  const open = state.chains
    .map((chain, chainIndex) => ({ chain, chainIndex }))
    .filter(({ chain }) => chain.lo <= chain.hi);
  if (open.length === 0) return null;

  // Round-robin: fewest questions asked of this chain so far wins.
  const perChain = new Map<number, number>();
  for (const a of state.asked) perChain.set(a.chainIndex, (perChain.get(a.chainIndex) ?? 0) + 1);
  open.sort(
    (a, b) =>
      (perChain.get(a.chainIndex) ?? 0) - (perChain.get(b.chainIndex) ?? 0) ||
      b.chain.ids.length - a.chain.ids.length,
  );

  for (const { chain, chainIndex } of open) {
    for (let offset = 0; offset <= chain.hi - chain.lo; offset++) {
      const mid = Math.floor((chain.lo + chain.hi) / 2);
      // Prefer the midpoint, then walk outward if it was already asked in another chain.
      const candidate = mid + (offset % 2 === 0 ? offset / 2 : -Math.ceil(offset / 2));
      if (candidate < chain.lo || candidate > chain.hi) continue;
      const conceptId = chain.ids[candidate];
      if (!conceptId || alreadyAsked.has(conceptId)) continue;
      return {
        conceptId,
        chainIndex,
        position: candidate,
        chainLength: chain.ids.length,
      };
    }
  }
  return null;
}

/** A pass implies the foundations below it, so the window moves up; a failure moves it down. */
export function applyAnswer(
  state: IntakeState,
  probe: ProbeChoice,
  correct: boolean,
): IntakeState {
  const chains = state.chains.map((chain, i) => {
    if (i !== probe.chainIndex) return chain;
    return correct
      ? { ...chain, lo: probe.position + 1 }
      : { ...chain, hi: probe.position - 1 };
  });
  return {
    chains,
    asked: [...state.asked, { conceptId: probe.conceptId, chainIndex: probe.chainIndex, correct }],
  };
}

export interface DerivedBelief {
  conceptId: string;
  mastery: MasteryLevel;
  /** `assessed` when directly probed; `inferred` when implied by a pass above it. */
  source: "assessed" | "inferred";
}

/** Probed concepts are `assessed`; anything below a pass is `inferred` and still worth probing. (06) */
export function derivedBeliefs(state: IntakeState): DerivedBelief[] {
  const out = new Map<string, DerivedBelief>();

  for (const chain of state.chains) {
    // Everything strictly below `lo` was cleared by a pass higher up.
    for (let i = 0; i < chain.lo; i++) {
      const id = chain.ids[i];
      if (id && !out.has(id)) out.set(id, { conceptId: id, mastery: "functional", source: "inferred" });
    }
  }
  // Direct evidence overwrites inference, never the other way round.
  for (const a of state.asked) {
    out.set(a.conceptId, {
      conceptId: a.conceptId,
      mastery: a.correct ? "functional" : "unknown",
      source: "assessed",
    });
  }
  return [...out.values()];
}

/** The topic's concepts and prerequisite edges, ready for `buildChains`. */
export async function loadTopicGraph(
  prisma: PrismaClient,
  topicId: string,
): Promise<{ conceptIds: string[]; edges: { srcId: string; dstId: string }[] }> {
  const links = await prisma.topicConcept.findMany({
    where: { topicId, relation: "contains", concept: { deprecatedAt: null } },
  });
  const conceptIds = links.map((l) => l.conceptId);
  const edges = await prisma.edge.findMany({
    where: {
      type: "prerequisite_of",
      retiredAt: null,
      srcId: { in: conceptIds },
      dstId: { in: conceptIds },
    },
    select: { srcId: true, dstId: true },
  });
  return { conceptIds, edges };
}
