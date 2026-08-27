import ELK from "elkjs/lib/elk.bundled.js";
import type { GraphEdge, GraphNode } from "./api";

const elk = new ELK();

export interface Positioned {
  id: string;
  x: number;
  y: number;
}

export const NODE_W = 190;
export const NODE_H = 52;

/** Layered top-to-bottom, so prerequisites sit above what needs them. */
export async function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Promise<Map<string, Positioned>> {
  const layering = edges.filter((e) => e.type === "prerequisite_of");

  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.spacing.nodeNode": "34",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      // Soft prerequisite pairs can cycle, and the layout must not hang.
      "elk.layered.cycleBreaking.strategy": "GREEDY",
    },
    children: nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
    edges: layering.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const result = await elk.layout(graph as never);
  const out = new Map<string, Positioned>();
  for (const child of result.children ?? []) {
    out.set(child.id!, { id: child.id!, x: child.x ?? 0, y: child.y ?? 0 });
  }
  // ELK leaves nodes with no prerequisite edge unplaced.
  let orphan = 0;
  const maxX = Math.max(0, ...[...out.values()].map((p) => p.x));
  for (const n of nodes) {
    if (out.has(n.id)) continue;
    out.set(n.id, { id: n.id, x: maxX + NODE_W + 120, y: orphan * (NODE_H + 24) });
    orphan++;
  }
  return out;
}
