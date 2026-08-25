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

/**
 * Layered top-to-bottom layout: prerequisites sit above the concepts that need them.
 *
 * A force-directed layout — the usual reflex for "knowledge graph" — is actively wrong
 * here. It optimises for even spacing and produces a hairball in which a chain like
 * variables -> functions -> closures -> memoization is invisible. Direction and depth
 * ARE the information in a prerequisite graph, so the layout has to encode them.
 *
 * Only `prerequisite_of` edges constrain layering; `related_to` and the rest would
 * otherwise pull unrelated concepts onto the same rank and flatten the hierarchy.
 */
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
      // Cycles cannot reach here through hard edges (the DB rejects them), but a soft
      // prerequisite pair can, and the layout must not hang on one.
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
  // Anything with no prerequisite edges is unplaced by the layered pass; park it in a
  // trailing column rather than stacking every orphan at the origin.
  let orphan = 0;
  const maxX = Math.max(0, ...[...out.values()].map((p) => p.x));
  for (const n of nodes) {
    if (out.has(n.id)) continue;
    out.set(n.id, { id: n.id, x: maxX + NODE_W + 120, y: orphan * (NODE_H + 24) });
    orphan++;
  }
  return out;
}
