import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background, Controls, MiniMap, ReactFlow, type Edge, type Node,
} from "@xyflow/react";
import { api, type GraphPayload, type Mastery } from "../api";
import { layoutGraph } from "../layout";
import { ConceptNode, type ConceptNodeData } from "../components/ConceptNode";

const nodeTypes = { concept: ConceptNode };

function Inspector({ graph, id }: { graph: GraphPayload; id: string | null }) {
  if (!id) {
    return (
      <aside className="inspector">
        <p className="muted">Select a concept to see its dependencies and failure modes.</p>
        <section>
          <h4>Reading this graph</h4>
          <p className="muted" style={{ fontSize: 13 }}>
            Layered top to bottom: a concept sits below everything it requires. Solid edges
            are <code>hard</code> prerequisites — the target genuinely cannot be understood
            without them. Dashed edges are <code>soft</code>: they add depth, and only a
            <code> build</code>-depth goal pulls them into a plan.
          </p>
        </section>
      </aside>
    );
  }
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return <aside className="inspector" />;

  const incoming = graph.edges.filter((e) => e.target === id);
  const outgoing = graph.edges.filter((e) => e.source === id);
  const name = (nid: string) => graph.nodes.find((n) => n.id === nid)?.name ?? nid;

  return (
    <aside className="inspector">
      <h3>{node.name}</h3>
      <p className="sense">{node.sense}</p>

      {node.state && (
        <section>
          <h4>Learner state</h4>
          <div className="rel">
            {node.state.mastery} · confidence {node.state.confidence.toFixed(2)} ·{" "}
            <span className="muted">{node.state.source}</span>
          </div>
        </section>
      )}

      <section>
        <h4>Requires ({incoming.length})</h4>
        {incoming.length === 0 && <p className="muted">Nothing — this is a foundation here.</p>}
        {incoming.map((e) => (
          <div className="rel" key={e.id}>
            <strong>{name(e.source)}</strong>{" "}
            <span className="muted mono">{e.strength}</span>
            {e.failureMode && <div className="fm">Without it: {e.failureMode}</div>}
          </div>
        ))}
      </section>

      <section>
        <h4>Unlocks ({outgoing.length})</h4>
        {outgoing.length === 0 && <p className="muted">Nothing downstream yet.</p>}
        {outgoing.map((e) => (
          <div className="rel" key={e.id}>
            <strong>{name(e.target)}</strong> <span className="muted mono">{e.strength}</span>
          </div>
        ))}
      </section>

      {node.topics.length > 0 && (
        <section>
          <h4>Topics</h4>
          {node.topics.map((t) => (
            <div className="rel" key={t.id}>
              {t.name} {!t.direct && <span className="muted mono">(via prerequisite)</span>}
            </div>
          ))}
        </section>
      )}

      {node.aliases.length > 1 && (
        <section>
          <h4>Also known as</h4>
          <div className="rel mono">{node.aliases.join(", ")}</div>
        </section>
      )}
    </aside>
  );
}

export function GraphPage() {
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [topicId, setTopicId] = useState("");
  const [learnerId, setLearnerId] = useState("");
  const [learners, setLearners] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { api.learners().then(setLearners).catch(() => undefined); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const g = await api.graph({
        ...(topicId ? { topicId } : {}),
        ...(learnerId ? { learnerId } : {}),
      });
      setGraph(g);

      const positions = await layoutGraph(g.nodes, g.edges);
      const unlocks = new Map<string, number>();
      for (const e of g.edges) {
        if (e.type !== "prerequisite_of") continue;
        unlocks.set(e.source, (unlocks.get(e.source) ?? 0) + 1);
      }

      setNodes(
        g.nodes.map((n): Node => {
          const p = positions.get(n.id)!;
          const data: ConceptNodeData = {
            name: n.name,
            mastery: (n.state?.mastery as Mastery) ?? null,
            confidence: n.state?.confidence ?? null,
            inferred: n.state?.source === "inferred",
            topics: n.topics.map((t) => t.name),
            unlocks: unlocks.get(n.id) ?? 0,
          };
          return { id: n.id, type: "concept", position: { x: p.x, y: p.y }, data };
        }),
      );

      setEdges(
        g.edges.map((e): Edge => ({
          id: e.id,
          source: e.source,
          target: e.target,
          animated: false,
          // Strength is encoded in the stroke, because it changes whether a plan
          // must include the edge at all.
          style: {
            stroke: e.provisional ? "var(--accent)" : "var(--rule-strong)",
            strokeWidth: e.strength === "hard" ? 1.8 : 1.2,
            strokeDasharray: e.strength === "soft" ? "4 3" : undefined,
          },
          label: e.type === "prerequisite_of" ? undefined : e.type.replace("_", " "),
          labelStyle: { fontSize: 10, fill: "var(--ink-soft)" },
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [topicId, learnerId]);

  useEffect(() => { void load(); }, [load]);

  const topics = graph?.topics ?? [];
  const counts = useMemo(() => {
    if (!graph) return null;
    const hard = graph.edges.filter((e) => e.strength === "hard").length;
    return { nodes: graph.nodes.length, hard, soft: graph.edges.length - hard };
  }, [graph]);

  return (
    <div className="page flush" style={{ flexDirection: "column" }}>
      <div className="toolbar">
        <label className="field">
          topic
          <select value={topicId} onChange={(e) => setTopicId(e.target.value)}>
            <option value="">all</option>
            {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="field">
          colour by learner
          <select value={learnerId} onChange={(e) => setLearnerId(e.target.value)}>
            <option value="">none</option>
            {learners.map((l) => <option key={l.id} value={l.id}>{l.email}</option>)}
          </select>
        </label>
        <button onClick={() => void load()} disabled={loading}>
          {loading ? "laying out…" : "reload"}
        </button>
        <span className="spacer" />
        <div className="legend">
          <span><span className="swatch" style={{ background: "var(--m-unknown)" }} />unknown</span>
          <span><span className="swatch" style={{ background: "var(--m-familiar)" }} />familiar</span>
          <span><span className="swatch" style={{ background: "var(--m-functional)" }} />functional</span>
          <span><span className="swatch" style={{ background: "var(--m-solid)" }} />solid</span>
          {counts && (
            <span className="mono">
              {counts.nodes} concepts · {counts.hard} hard · {counts.soft} soft
            </span>
          )}
        </div>
      </div>

      {error && <div className="page"><p className="err">{error}</p></div>}

      {!error && (
        <div className="graph-wrap">
          <div className="canvas">
            {graph && graph.nodes.length === 0 ? (
              <div className="page">
                <div className="empty">
                  No concepts yet. Run <code>pnpm --filter @kg/api seed</code>, or expand a
                  topic once a model key is configured.
                </div>
              </div>
            ) : (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodeClick={(_, n) => setSelected(n.id)}
                onPaneClick={() => setSelected(null)}
                fitView
                minZoom={0.1}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={18} size={1} color="var(--rule)" />
                <Controls showInteractive={false} />
                {/* React Flow writes these straight onto SVG attributes, where a CSS variable
                    does not resolve — so they have to be literals that read on both grounds. */}
                <MiniMap pannable zoomable nodeColor="#7d8a88" maskColor="transparent" />
              </ReactFlow>
            )}
          </div>
          {graph && <Inspector graph={graph} id={selected} />}
        </div>
      )}
    </div>
  );
}
