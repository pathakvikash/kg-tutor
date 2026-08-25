import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { api, type GraphEdge, type GraphPayload, type Mastery } from "../api";
import { layoutGraph } from "../layout";
import { neighborhood, runForceLayout } from "../force";
import { ConceptNode, type ConceptNodeData } from "../components/ConceptNode";

const nodeTypes = { concept: ConceptNode };
type Mode = "explore" | "teach";

interface Selection {
  kind: "node" | "edge";
  id: string;
}

function Inspector({
  graph, selection, trail, onHop, onFocus, focusId, hops, onHops,
}: {
  graph: GraphPayload;
  selection: Selection | null;
  trail: string[];
  onHop: (id: string) => void;
  onFocus: (id: string | null) => void;
  focusId: string | null;
  hops: number;
  onHops: (n: number) => void;
}) {
  const name = (id: string) => graph.nodes.find((n) => n.id === id)?.name ?? id;

  if (!selection) {
    return (
      <aside className="inspector">
        <h4>Exploring</h4>
        <p className="muted" style={{ fontSize: 13 }}>
          Click a concept to see what it needs and what it unlocks. Click an edge to see
          the dependency itself — including the specific misunderstanding that happens
          without it, which is what the tutor uses to diagnose a wrong answer.
        </p>
        <section>
          <h4>Modes</h4>
          <p className="muted" style={{ fontSize: 13 }}>
            <strong>Explore</strong> clusters by connection — good for finding hubs and
            gaps. <strong>Teach</strong> layers by dependency — good for reading the order
            a learner would go through.
          </p>
        </section>
      </aside>
    );
  }

  if (selection.kind === "edge") {
    const e = graph.edges.find((x) => x.id === selection.id);
    if (!e) return <aside className="inspector" />;
    return (
      <aside className="inspector">
        <h4>Dependency</h4>
        <h3 style={{ fontSize: 15, lineHeight: 1.3 }}>
          <button className="linkish" onClick={() => onHop(e.source)}>{name(e.source)}</button>
          {" → "}
          <button className="linkish" onClick={() => onHop(e.target)}>{name(e.target)}</button>
        </h3>
        <div className="chips">
          <span className={`chip ${e.strength === "hard" ? "hard" : ""}`}>{e.strength}</span>
          <span className="chip">{e.type.replace(/_/g, " ")}</span>
          <span className="chip">confidence {e.confidence.toFixed(2)}</span>
          {e.provisional && <span className="chip prov">provisional</span>}
        </div>
        <section style={{ marginTop: 14 }}>
          <h4>Failure mode</h4>
          {e.failureMode ? (
            <div className="edge-detail">{e.failureMode}</div>
          ) : (
            <p className="muted">
              None — which is why this is <code>soft</code>. A hard edge is only accepted
              with a concrete failure named.
            </p>
          )}
        </section>
        {e.provisional && (
          <p className="muted" style={{ fontSize: 12 }}>
            Promoted from learner evidence and still monitored. Reversible from Review.
          </p>
        )}
      </aside>
    );
  }

  const node = graph.nodes.find((n) => n.id === selection.id);
  if (!node) return <aside className="inspector" />;
  const incoming = graph.edges.filter((e) => e.target === node.id);
  const outgoing = graph.edges.filter((e) => e.source === node.id);

  return (
    <aside className="inspector">
      {trail.length > 1 && (
        <div className="hop-path" style={{ marginBottom: 10 }}>
          {trail.slice(-4).map((id, i, arr) => (
            <span key={`${id}-${i}`}>
              <button onClick={() => onHop(id)}>{name(id)}</button>
              {i < arr.length - 1 && <span className="sep"> › </span>}
            </span>
          ))}
        </div>
      )}
      <h3>{node.name}</h3>
      <p className="sense">{node.sense}</p>

      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        <button onClick={() => onFocus(focusId === node.id ? null : node.id)}>
          {focusId === node.id ? "Clear focus" : "Focus neighbourhood"}
        </button>
        {focusId === node.id && (
          <select value={hops} onChange={(e) => onHops(Number(e.target.value))}>
            <option value={1}>1 hop</option>
            <option value={2}>2 hops</option>
            <option value={3}>3 hops</option>
          </select>
        )}
      </div>

      {node.state && (
        <section>
          <h4>Learner state</h4>
          <div className="rel">
            {node.state.mastery} · confidence {node.state.confidence.toFixed(2)}{" "}
            <span className="muted">({node.state.source})</span>
          </div>
        </section>
      )}

      <section>
        <h4>Requires ({incoming.length})</h4>
        {incoming.length === 0 && <p className="muted">Nothing — a starting point here.</p>}
        {incoming.map((e) => (
          <div className="rel" key={e.id}>
            <button className="linkish" onClick={() => onHop(e.source)}>{name(e.source)}</button>{" "}
            <span className={`chip ${e.strength === "hard" ? "hard" : ""}`}>{e.strength}</span>
            {e.failureMode && <div className="fm">Without it: {e.failureMode}</div>}
          </div>
        ))}
      </section>

      <section>
        <h4>Unlocks ({outgoing.length})</h4>
        {outgoing.length === 0 && <p className="muted">Nothing downstream yet.</p>}
        {outgoing.map((e) => (
          <div className="rel" key={e.id}>
            <button className="linkish" onClick={() => onHop(e.target)}>{name(e.target)}</button>{" "}
            <span className={`chip ${e.strength === "hard" ? "hard" : ""}`}>{e.strength}</span>
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
    </aside>
  );
}

export function GraphPage() {
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [mode, setMode] = useState<Mode>("explore");
  const [topicId, setTopicId] = useState("");
  const [learnerId, setLearnerId] = useState("");
  const [learners, setLearners] = useState<any[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hops, setHops] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(true);
  const stamp = useRef<string>("");

  useEffect(() => { void api.learners().then(setLearners).catch(() => undefined); }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const g = await api.graph({
        ...(topicId ? { topicId } : {}),
        ...(learnerId ? { learnerId } : {}),
      });
      setGraph(g);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  }, [topicId, learnerId]);

  useEffect(() => { void load(); }, [load]);

  // Poll a cheap stamp instead of refetching the graph: the view follows real changes
  // (an expansion finishing, a lesson updating mastery) without hammering the API.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(async () => {
      try {
        const v = await fetch("/api/graph/version").then((r) => r.json());
        if (stamp.current && v.stamp !== stamp.current) void load();
        stamp.current = v.stamp;
      } catch { /* transient; the next tick retries */ }
    }, 3000);
    return () => clearInterval(timer);
  }, [live, load]);

  const visible = useMemo(() => {
    if (!graph || !focusId) return null;
    return neighborhood(focusId, graph.edges, hops);
  }, [graph, focusId, hops]);

  // Layout is the expensive step, so it only reruns when the graph or mode changes —
  // not when selection or focus does.
  useEffect(() => {
    if (!graph) return;
    let cancelled = false;

    void (async () => {
      const positions =
        mode === "teach"
          ? await layoutGraph(graph.nodes, graph.edges)
          : runForceLayout(graph.nodes, graph.edges, { width: 900, height: 620 });
      if (cancelled) return;

      const degree = new Map<string, number>();
      const unlocks = new Map<string, number>();
      for (const e of graph.edges) {
        degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
        if (e.type === "prerequisite_of") unlocks.set(e.source, (unlocks.get(e.source) ?? 0) + 1);
      }

      setNodes(
        graph.nodes.map((n): Node => {
          const p = positions.get(n.id) ?? { x: 0, y: 0 };
          const data: ConceptNodeData = {
            name: n.name,
            mastery: (n.state?.mastery as Mastery) ?? null,
            inferred: n.state?.source === "inferred",
            unlocks: unlocks.get(n.id) ?? 0,
            degree: degree.get(n.id) ?? 0,
            mode,
            dimmed: false,
            isFocus: false,
          };
          return { id: n.id, type: "concept", position: { x: p.x, y: p.y }, data };
        }),
      );
      setEdges(graph.edges.map((e) => toFlowEdge(e, false)));
    })();

    return () => { cancelled = true; };
  }, [graph, mode]);

  // Dimming is a cheap data update, kept separate so focusing never triggers a relayout.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => ({
        ...n,
        data: {
          ...(n.data as ConceptNodeData),
          dimmed: visible ? !visible.has(n.id) : false,
          isFocus: n.id === focusId,
        },
      })),
    );
    setEdges((prev) =>
      prev.map((e) => ({
        ...e,
        style: {
          ...e.style,
          opacity: visible && !(visible.has(e.source) && visible.has(e.target)) ? 0.08 : 1,
        },
      })),
    );
  }, [visible, focusId]);

  const hopTo = (id: string) => {
    setSelection({ kind: "node", id });
    setTrail((t) => (t[t.length - 1] === id ? t : [...t, id]));
  };

  const counts = graph
    ? {
        nodes: graph.nodes.length,
        hard: graph.edges.filter((e) => e.strength === "hard").length,
        soft: graph.edges.filter((e) => e.strength !== "hard").length,
      }
    : null;

  return (
    <div className="page flush" style={{ flexDirection: "column" }}>
      <div className="toolbar">
        <label className="field">
          view
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="explore">explore — cluster by connection</option>
            <option value="teach">teach — layer by dependency</option>
          </select>
        </label>
        <label className="field">
          topic
          <select value={topicId} onChange={(e) => setTopicId(e.target.value)}>
            <option value="">all</option>
            {(graph?.topics ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="field">
          learner
          <select value={learnerId} onChange={(e) => setLearnerId(e.target.value)}>
            <option value="">none</option>
            {learners.map((l) => <option key={l.id} value={l.id}>{l.email}</option>)}
          </select>
        </label>
        {focusId && <button onClick={() => setFocusId(null)}>Clear focus</button>}
        <button onClick={() => void load()} disabled={loading}>{loading ? "…" : "reload"}</button>
        <span className="spacer" />
        <span className="live" title="Polls for changes every 3s">
          <span className="pulse" style={{ background: live ? undefined : "var(--rule-strong)" }} />
          <button
            style={{ border: "none", background: "none", padding: 0, color: "inherit" }}
            onClick={() => setLive((v) => !v)}
          >
            {live ? "live" : "paused"}
          </button>
        </span>
        <div className="legend">
          <span><span className="swatch" style={{ background: "var(--m-unknown)" }} />unknown</span>
          <span><span className="swatch" style={{ background: "var(--m-familiar)" }} />familiar</span>
          <span><span className="swatch" style={{ background: "var(--m-functional)" }} />functional</span>
          <span><span className="swatch" style={{ background: "var(--m-solid)" }} />solid</span>
          {counts && <span className="mono">{counts.nodes} · {counts.hard} hard · {counts.soft} soft</span>}
        </div>
      </div>

      {error && <div className="page"><p className="err">{error}</p></div>}

      {!error && (
        <div className="graph-wrap">
          <div className="canvas">
            {graph && graph.nodes.length === 0 ? (
              <div className="page">
                <div className="empty">
                  No concepts yet. Run <code>pnpm --filter @kg/api seed</code>, or expand a topic.
                </div>
              </div>
            ) : (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodeClick={(_, n) => hopTo(n.id)}
                onEdgeClick={(_, e) => setSelection({ kind: "edge", id: e.id })}
                onPaneClick={() => { setSelection(null); setTrail([]); }}
                fitView
                fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
                minZoom={0.05}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={20} size={1} color="var(--rule)" />
                <Controls showInteractive={false} />
                <MiniMap pannable zoomable nodeColor="#7d8a88" maskColor="transparent" />
              </ReactFlow>
            )}
          </div>
          {graph && (
            <Inspector
              graph={graph}
              selection={selection}
              trail={trail}
              onHop={hopTo}
              onFocus={setFocusId}
              focusId={focusId}
              hops={hops}
              onHops={setHops}
            />
          )}
        </div>
      )}
    </div>
  );
}

function toFlowEdge(e: GraphEdge, dim: boolean): Edge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    // Clickable and thick enough to hit — an unclickable edge hides the failure mode,
    // which is the most useful thing on it.
    interactionWidth: 18,
    style: {
      stroke: e.provisional ? "var(--accent)" : "var(--rule-strong)",
      strokeWidth: e.strength === "hard" ? 1.8 : 1.2,
      strokeDasharray: e.strength === "soft" ? "4 3" : undefined,
      opacity: dim ? 0.08 : 1,
    },
  };
}
