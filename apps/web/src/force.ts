import {
  forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceY,
  type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from "d3-force";
import type { GraphEdge, GraphNode } from "./api";

export interface ForceNode extends SimulationNodeDatum {
  id: string;
  degree: number;
  /** Longest prerequisite chain behind this concept. Drives the vertical bias. */
  depth: number;
}
type ForceLink = SimulationLinkDatum<ForceNode> & { strength: "hard" | "soft" };

export interface ForceResult {
  positions: Map<string, { x: number; y: number }>;
  simulation: Simulation<ForceNode, ForceLink>;
}

/**
 * Longest prerequisite chain behind each concept. Foundations are 0 and everything
 * else is one past its deepest prerequisite.
 */
export function prerequisiteDepth(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type !== "prerequisite_of") continue;
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const walk = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    // A soft prerequisite pair may cycle; the DB only forbids hard ones.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = incoming.get(id) ?? [];
    const d = parents.length === 0 ? 0 : Math.max(...parents.map(walk)) + 1;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  for (const n of nodes) walk(n.id);
  return depth;
}

/**
 * Force-directed layout with a vertical bias by prerequisite depth.
 *
 * A pure force layout clusters beautifully and reads terribly: with no orientation, a
 * chain like call stack → event loop → promises could be drawn in any direction, and a
 * reader cannot tell where to start. That was the actual complaint about this view.
 *
 * So: horizontal position comes from the simulation (clustering, hubs, density) while
 * vertical position is pulled toward the concept's depth. Foundations settle at the top,
 * everything that depends on them below. Organic clustering, readable direction —
 * neither the hairball nor the rigid diagram.
 */
export function runForceLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: { width: number; height: number; ticks?: number } = { width: 1200, height: 800 },
): Map<string, { x: number; y: number }> {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const depth = prerequisiteDepth(nodes, edges);
  const maxDepth = Math.max(1, ...[...depth.values()]);
  const rowHeight = Math.max(110, opts.height / (maxDepth + 1));
  const depthY = (id: string) => 60 + (depth.get(id) ?? 0) * rowHeight;

  const simNodes: ForceNode[] = nodes.map((n, i) => ({
    id: n.id,
    degree: degree.get(n.id) ?? 0,
    depth: depth.get(n.id) ?? 0,
    // Seed on a circle rather than at the origin: a symmetric start makes the layout
    // reproducible instead of depending on how the simulation happens to break ties.
    x: opts.width / 2 + Math.cos((i / nodes.length) * Math.PI * 2) * 180,
    y: depthY(n.id),
  }));
  const byId = new Map(simNodes.map((n) => [n.id, n]));

  const simLinks: ForceLink[] = edges
    .filter((e) => byId.has(e.source) && byId.has(e.target))
    .map((e) => ({ source: e.source, target: e.target, strength: e.strength }));

  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink<ForceNode, ForceLink>(simLinks)
        .id((d) => d.id)
        .distance((l) => (l.strength === "hard" ? 95 : 150))
        .strength((l) => (l.strength === "hard" ? 1 : 0.3)),
    )
    // Hubs repel more, so dense areas open up instead of collapsing into a knot.
    .force("charge", forceManyBody<ForceNode>().strength((d) => -230 - d.degree * 45))
    .force("center", forceCenter(opts.width / 2, opts.height / 2))
    // The bias that makes direction readable. Strong enough to hold the ordering,
    // weak enough that clustering still does the horizontal work.
    .force("depth", forceY<ForceNode>((d) => depthY(d.id)).strength(0.85))
    .force("collide", forceCollide<ForceNode>().radius((d) => 34 + d.degree * 1.8))
    .stop();

  // Run to completion synchronously: an animated settle looks alive but makes the graph
  // unusable while it moves, and the user is here to read it.
  sim.tick(opts.ticks ?? 320);

  const out = new Map<string, { x: number; y: number }>();
  for (const n of simNodes) out.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
  return out;
}

/** Concepts within `hops` of a seed, following edges in both directions. */
export function neighborhood(
  seedId: string,
  edges: GraphEdge[],
  hops: number,
): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    adjacency.set(e.source, [...(adjacency.get(e.source) ?? []), e.target]);
    adjacency.set(e.target, [...(adjacency.get(e.target) ?? []), e.source]);
  }
  const seen = new Set([seedId]);
  let frontier = [seedId];
  for (let i = 0; i < hops; i++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adjacency.get(id) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return seen;
}
