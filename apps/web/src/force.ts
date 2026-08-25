import {
  forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation,
  type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from "d3-force";
import type { GraphEdge, GraphNode } from "./api";

export interface ForceNode extends SimulationNodeDatum {
  id: string;
  degree: number;
}
type ForceLink = SimulationLinkDatum<ForceNode> & { strength: "hard" | "soft" };

export interface ForceResult {
  positions: Map<string, { x: number; y: number }>;
  simulation: Simulation<ForceNode, ForceLink>;
}

/**
 * Force-directed layout, for exploring the graph rather than reading a teaching order.
 *
 * This answers different questions from the layered view: which concepts are hubs,
 * where the graph is dense, what sits near what. It deliberately does NOT preserve
 * prerequisite direction — for "what do I teach first", use the layered mode.
 *
 * Hard prerequisites pull harder than soft ones, so genuinely coupled clusters sit
 * together and merely-related concepts drift apart.
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

  const simNodes: ForceNode[] = nodes.map((n, i) => ({
    id: n.id,
    degree: degree.get(n.id) ?? 0,
    // Seed on a circle rather than at the origin: a symmetric start makes the layout
    // reproducible instead of depending on how the simulation happens to break ties.
    x: opts.width / 2 + Math.cos((i / nodes.length) * Math.PI * 2) * 180,
    y: opts.height / 2 + Math.sin((i / nodes.length) * Math.PI * 2) * 180,
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
