import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useStickyLearner } from "../useLearner";
import {
  Background, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider,
  useReactFlow, type Edge, type Node,
} from "@xyflow/react";
import { api, apiUrl, HttpError, type GraphEdge, type GraphPayload, type Mastery } from "../api";
import { layoutGraph, NODE_H, NODE_W } from "../layout";
import { neighborhood, runForceLayout, ORB_H, ORB_W } from "../force";
import { ConceptNode, type ConceptNodeData } from "../components/ConceptNode";
import { NodeCoach } from "../components/NodeCoach";
import { Busy } from "../components/Busy";
import { atLeast, MASTERY_MEANING, MASTERY_ORDER } from "../vocabulary";

const nodeTypes = { concept: ConceptNode };

const FIT = { padding: 0.14, maxZoom: 1.6, duration: 200 };

const LEGEND_BREAKPOINT = 900;

type Mode = "explore" | "teach";

interface Selection {
  kind: "node" | "edge";
  id: string;
}

interface LaidOut {
  mode: Mode;
  nodes: Node[];
  edges: Edge[];
}

const NO_NODES: Node[] = [];
const NO_EDGES: Edge[] = [];

function useNarrow(px: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${px}px)`);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [px]);
  return narrow;
}

function DeepenButton({
  conceptId, conceptName, onDone,
}: { conceptId: string; conceptName: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);
  const relayoutPending = useRef(false);

  const run = async () => {
    if (busy) return;
    setBusy(true); setResult(null);
    try {
      const r = await api.deepen(conceptId);
      const added = r.prerequisitesAfter - r.prerequisitesBefore;
      setResult({
        ok: true,
        text:
          added === 0
            ? `Nothing new — the model named ${r.conceptsReused} concept(s) already here.`
            : `${added} new prerequisite${added === 1 ? "" : "s"} · ` +
              `${r.conceptsCreated} new concept(s), ${r.conceptsReused} reused` +
              (r.edgesRejectedAsCycle > 0 ? `, ${r.edgesRejectedAsCycle} rejected as a cycle` : ""),
      });
      relayoutPending.current = true;
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const dismiss = () => {
    const redraw = relayoutPending.current;
    relayoutPending.current = false;
    setResult(null);
    if (redraw) onDone();
  };

  return (
    <section className="deepen">
      <h4 className="eyebrow">Go deeper</h4>
      <p className="muted deepen-why">
        Asks the model what {conceptName} builds on. This adds concepts and edges to the
        shared graph — it is not a change to one learner.
      </p>
      <div className="row">
        <button
          onClick={() => void run()}
          aria-disabled={busy}
          title={`Find what ${conceptName} builds on`}
        >
          Go one level deeper
        </button>
        {busy && <Busy label="asking the model" />}
      </div>
      {result && (
        <div
          className={`notice ${result.ok ? "notice--info" : "notice--error"} deepen-result`}
          role={result.ok ? undefined : "alert"}
        >
          <p>{result.text}</p>
          <button className="linkish" onClick={dismiss}>
            {result.ok && relayoutPending.current ? "Redraw the graph" : "Dismiss"}
          </button>
        </div>
      )}
    </section>
  );
}

function Legend({
  mode, hasLearner, counts,
}: {
  mode: Mode;
  hasLearner: boolean;
  counts: { nodes: number; hard: number; soft: number } | null;
}) {
  return (
    <div className="legend">
      {mode === "explore" && (
        <span className="lg">
          <span className="lg-orbs" aria-hidden="true">
            <span className="lg-orb lg-orb--sm" />
            <span className="lg-orb lg-orb--lg" />
          </span>
          size = connections
        </span>
      )}
      {hasLearner ? (
        <span className="lg lg-mastery">
          {MASTERY_ORDER.map((m) => (
            <span className="lg-level" key={m} title={MASTERY_MEANING[m]}>
              <span className="mastery-mark" data-level={m} />
              {m}
            </span>
          ))}
        </span>
      ) : (
        <span className="lg muted">Pick a learner to colour concepts by mastery</span>
      )}
      <span className="lg">
        <svg className="lg-line" viewBox="0 0 26 6" aria-hidden="true">
          <line x1="0" y1="3" x2="26" y2="3" stroke="var(--rule-strong)" strokeWidth="1.8" />
        </svg>
        hard — required
      </span>
      <span className="lg">
        <svg className="lg-line" viewBox="0 0 26 6" aria-hidden="true">
          <line
            x1="0" y1="3" x2="26" y2="3"
            stroke="var(--rule-strong)" strokeWidth="1.2" strokeDasharray="4 3"
          />
        </svg>
        soft — adds depth
      </span>
      <span className="lg">
        <svg className="lg-line" viewBox="0 0 26 6" aria-hidden="true">
          <line x1="0" y1="3" x2="26" y2="3" stroke="var(--accent)" strokeWidth="1.8" />
        </svg>
        provisional
      </span>
      <span className="lg">arrows run from a prerequisite to what it unlocks</span>
      {counts && (
        <span className="lg mono">
          {counts.nodes} concepts · {counts.hard} hard · {counts.soft} soft
        </span>
      )}
    </div>
  );
}

function Inspector({
  graph, selection, trail, onHop, onFocus, focusId, learnerId, onStateChanged, headingRef,
}: {
  graph: GraphPayload;
  selection: Selection | null;
  trail: string[];
  onHop: (id: string) => void;
  onFocus: (id: string | null) => void;
  focusId: string | null;
  learnerId: string;
  onStateChanged: () => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const name = (id: string) => graph.nodes.find((n) => n.id === id)?.name ?? id;

  if (!selection) {
    return (
      <>
        <h3 className="insp-title">Exploring</h3>
        <p className="muted insp-lead">
          Click a concept to see what it needs and what it unlocks. Click an edge to see
          the dependency itself — including the specific misunderstanding that happens
          without it, which is what the tutor uses to diagnose a wrong answer.
        </p>
        <section className="insp-section">
          <h4 className="eyebrow">Modes</h4>
          <p className="muted insp-lead">
            <strong>Explore</strong> clusters by connection — good for finding hubs and
            gaps. <strong>Teach</strong> layers by dependency — good for reading the order
            a learner would go through.
          </p>
        </section>
      </>
    );
  }

  if (selection.kind === "edge") {
    const e = graph.edges.find((x) => x.id === selection.id);
    if (!e) {
      return (
        <div className="notice notice--info">
          That dependency is not in this view. Pick another edge, or a concept.
        </div>
      );
    }
    return (
      <>
        <h3 className="insp-title" ref={headingRef} tabIndex={-1}>Dependency</h3>
        <p className="insp-pair">
          <button className="linkish" onClick={() => onHop(e.source)}>{name(e.source)}</button>
          {" → "}
          <button className="linkish" onClick={() => onHop(e.target)}>{name(e.target)}</button>
        </p>
        <div className="chips">
          <span className={`chip ${e.strength === "hard" ? "hard" : ""}`}>{e.strength}</span>
          <span className="chip">{e.type.replace(/_/g, " ")}</span>
          <span className="chip">confidence {e.confidence.toFixed(2)}</span>
          {e.provisional && <span className="chip prov">provisional</span>}
        </div>
        <section className="insp-section">
          <h4 className="eyebrow">Failure mode</h4>
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
          <p className="muted insp-note">
            Promoted from learner evidence and still monitored. Reversible from Review.
          </p>
        )}
      </>
    );
  }

  const node = graph.nodes.find((n) => n.id === selection.id);
  if (!node) {
    return (
      <div className="notice notice--info">
        That concept is not in this view — it may sit outside the current topic filter.
        Pick another concept on the canvas.
      </div>
    );
  }
  const incoming = graph.edges.filter((e) => e.target === node.id);
  const outgoing = graph.edges.filter((e) => e.source === node.id);

  return (
    <>
      {trail.length > 1 && (
        <nav className="hop-path" aria-label="concepts you came through">
          {trail.length > 4 && (
            <span className="sep" title={trail.map(name).join(" › ")}>…</span>
          )}
          {trail.slice(-4).map((id, i, arr) => (
            <span key={`${id}-${i}`}>
              <button onClick={() => onHop(id)}>{name(id)}</button>
              {i < arr.length - 1 && <span className="sep"> › </span>}
            </span>
          ))}
        </nav>
      )}
      <h3 className="insp-name" ref={headingRef} tabIndex={-1}>{node.name}</h3>
      <p className="sense">{node.sense}</p>

      <div className="row">
        <button onClick={() => onFocus(focusId === node.id ? null : node.id)}>
          {focusId === node.id ? "Clear focus" : "Focus neighbourhood"}
        </button>
      </div>

      {node.state && (
        <section className="insp-section">
          <h4 className="eyebrow">Learner state</h4>
          <div className="rel">
            <span className="mastery-mark" data-level={node.state.mastery} />{" "}
            {node.state.mastery} · confidence {node.state.confidence.toFixed(2)}{" "}
            <span className="muted">({node.state.source})</span>
          </div>
        </section>
      )}

      {learnerId ? (
        <NodeCoach
          learnerId={learnerId}
          conceptId={node.id}
          conceptName={node.name}
          mastery={(node.state?.mastery ?? "unknown") as Mastery}
          // Hard prerequisites only: a soft edge adds depth, it does not gate
          unmetPrerequisites={incoming
            .filter((e) => e.strength === "hard")
            .map((e) => graph.nodes.find((n) => n.id === e.source))
            .filter((n): n is NonNullable<typeof n> => Boolean(n))
            .filter((n) => !atLeast((n.state?.mastery ?? "unknown") as Mastery, "functional"))
            .map((n) => ({
              id: n.id, name: n.name, mastery: (n.state?.mastery ?? "unknown") as Mastery,
            }))}
          onStateChanged={onStateChanged}
          onPick={onHop}
        />
      ) : (
        <p className="muted insp-note">
          Pick a learner above to be assessed on this, or to ask about it.
        </p>
      )}

      <section className="insp-section">
        <h4 className="eyebrow">Requires ({incoming.length})</h4>
        {incoming.length === 0 && <p className="muted">Nothing — a starting point here.</p>}
        {incoming.map((e) => (
          <div className="rel" key={e.id}>
            <button className="linkish" onClick={() => onHop(e.source)}>{name(e.source)}</button>{" "}
            <span className={`chip ${e.strength === "hard" ? "hard" : ""}`}>{e.strength}</span>
            {e.failureMode && <div className="fm">Without it: {e.failureMode}</div>}
          </div>
        ))}
        <DeepenButton conceptId={node.id} conceptName={node.name} onDone={onStateChanged} />
      </section>

      <section className="insp-section">
        <h4 className="eyebrow">Unlocks ({outgoing.length})</h4>
        {outgoing.length === 0 && <p className="muted">Nothing downstream yet.</p>}
        {outgoing.map((e) => (
          <div className="rel" key={e.id}>
            <button className="linkish" onClick={() => onHop(e.target)}>{name(e.target)}</button>{" "}
            <span className={`chip ${e.strength === "hard" ? "hard" : ""}`}>{e.strength}</span>
          </div>
        ))}
      </section>

      {node.topics.length > 0 && (
        <section className="insp-section">
          <h4 className="eyebrow">Topics</h4>
          {node.topics.map((t) => (
            <div className="rel" key={t.id}>
              {t.name} {!t.direct && <span className="muted mono">(via prerequisite)</span>}
            </div>
          ))}
        </section>
      )}
    </>
  );
}

/** Split because useReactFlow needs a provider above the component calling fitView */
export function GraphPage() {
  return (
    <ReactFlowProvider>
      <Graph />
    </ReactFlowProvider>
  );
}

function Graph() {
  /** The whole view lives in the URL so refresh, back and sharing work */
  const [params, setParams] = useSearchParams();
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [layout, setLayout] = useState<LaidOut | null>(null);
  const [layingOut, setLayingOut] = useState(false);
  const mode = (params.get("view") === "teach" ? "teach" : "explore") as Mode;
  const topicId = params.get("topic") ?? "";
  const [stickyLearner, setStickyLearner] = useStickyLearner();
  const [learners, setLearners] = useState<any[]>([]);
  const stickyKnown = learners.length === 0 || learners.some((l) => l.id === stickyLearner);
  const learnerId = params.get("learner") ?? (stickyKnown ? stickyLearner : "");
  const selection: Selection | null = params.get("node")
    ? { kind: "node", id: params.get("node")! }
    : params.get("edge")
      ? { kind: "edge", id: params.get("edge")! }
      : null;
  const focusId = params.get("focus");
  const hops = Number(params.get("hops") ?? 1) || 1;
  const live = params.get("live") !== "off";
  const [trail, setTrail] = useState<string[]>([]);
  const [firstLoadError, setFirstLoadError] = useState<Error | null>(null);
  const [refreshError, setRefreshError] =
    useState<{ message: string; remedy: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const stamp = useRef<string>("");
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [focusDropped, setFocusDropped] = useState(false);

  const { fitView } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const graphRef = useRef<GraphPayload | null>(null);
  graphRef.current = graph;
  /** Arrow traversal keeps focus on the canvas; a click or Enter hands it to the panel */
  const keepCanvasFocus = useRef(false);
  const mounted = useRef(false);
  const narrow = useNarrow(LEGEND_BREAKPOINT);

  const patch = useCallback(
    (next: Record<string, string | null>, opts: { push?: boolean } = {}) => {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(next)) {
            if (v === null || v === "") out.delete(k);
            else out.set(k, v);
          }
          return out;
        },
        { replace: !opts.push },
      );
    },
    [setParams],
  );

  const setMode = (m: Mode) => patch({ view: m === "explore" ? null : m });
  const setTopicId = (id: string) => patch({ topic: id || null, node: null, edge: null, focus: null });
  const setLearnerId = (id: string) => { setStickyLearner(id); patch({ learner: id || null }); };
  const setFocusId = useCallback((id: string | null) => patch({ focus: id }), [patch]);
  const setHops = (n: number) => patch({ hops: n === 1 ? null : String(n) });
  const setLive = (fn: (v: boolean) => boolean) => patch({ live: fn(live) ? null : "off" });
  const setSelection = useCallback(
    (sel: Selection | null, opts: { push?: boolean } = {}) =>
      patch(
        sel === null
          ? { node: null, edge: null }
          : sel.kind === "node"
            ? { node: sel.id, edge: null }
            : { edge: sel.id, node: null },
        opts,
      ),
    [patch],
  );

  useEffect(() => { void api.learners().then(setLearners).catch(() => undefined); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const g = await api.graph({
        ...(topicId ? { topicId } : {}),
        ...(learnerId ? { learnerId } : {}),
      });
      setGraph(g);
      setFirstLoadError(null);
      setRefreshError(null);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (graphRef.current) {
        setRefreshError({ message: e.message, remedy: e instanceof HttpError ? e.remedy : null });
      } else {
        setFirstLoadError(e);
      }
    } finally { setLoading(false); }
  }, [topicId, learnerId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(async () => {
      try {
        const v = await fetch(apiUrl("/api/graph/version")).then((r) => r.json());
        if (stamp.current && v.stamp !== stamp.current) {
          void load();
          setRefreshedAt(Date.now());
        }
        stamp.current = v.stamp;
      } catch { /* transient; the next tick retries */ }
    }, 3000);
    return () => clearInterval(timer);
  }, [live, load]);

  const focusNode = focusId ? graph?.nodes.find((n) => n.id === focusId) ?? null : null;

  const visible = useMemo(() => {
    if (!graph || !focusId || !focusNode) return null;
    return neighborhood(focusId, graph.edges, hops);
  }, [graph, focusId, focusNode, hops]);

  useEffect(() => {
    if (!graph || !focusId) return;
    if (focusNode) { setFocusDropped(false); return; }
    setFocusDropped(true);
    setFocusId(null);
  }, [graph, focusId, focusNode, setFocusId]);

  const selectedNodeId = selection?.kind === "node" ? selection.id : null;

  useEffect(() => {
    if (!graph) return;
    let cancelled = false;
    setLayingOut(true);

    void (async () => {
      const box = canvasRef.current?.getBoundingClientRect();
      const size = {
        width: Math.max(640, Math.round(box?.width ?? 1000)),
        height: Math.max(420, Math.round(box?.height ?? 700)),
      };
      const positions =
        mode === "teach"
          ? await layoutGraph(graph.nodes, graph.edges)
          : runForceLayout(graph.nodes, graph.edges, size);
      if (cancelled) return;

      const degree = new Map<string, number>();
      const unlocks = new Map<string, number>();
      const requires = new Map<string, number>();
      const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
      for (const e of graph.edges) {
        degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
        requires.set(e.target, (requires.get(e.target) ?? 0) + 1);
        if (e.type === "prerequisite_of") unlocks.set(e.source, (unlocks.get(e.source) ?? 0) + 1);
      }

      const geometry =
        mode === "explore"
          ? { initialWidth: ORB_W, initialHeight: ORB_H, origin: [0.5, 0.5] as [number, number] }
          : { initialWidth: NODE_W, initialHeight: NODE_H, origin: [0, 0] as [number, number] };

      setLayout({
        mode,
        nodes: graph.nodes.map((n): Node => {
          const p = positions.get(n.id) ?? { x: 0, y: 0 };
          const need = requires.get(n.id) ?? 0;
          const opens = unlocks.get(n.id) ?? 0;
          const data: ConceptNodeData = {
            name: n.name,
            mastery: (n.state?.mastery as Mastery) ?? null,
            inferred: n.state?.source === "inferred",
            unlocks: opens,
            degree: degree.get(n.id) ?? 0,
            mode,
            // Set here too: the async elk layout lands after the dimming effect runs
            dimmed: visible ? !visible.has(n.id) : false,
            isFocus: n.id === focusId,
          };
          return {
            id: n.id,
            type: "concept",
            position: { x: p.x, y: p.y },
            data,
            ...geometry,
            selected: n.id === selectedNodeId,
            focusable: !data.dimmed,
            selectable: !data.dimmed,
            ariaLabel:
              `${n.name}. ${n.state ? n.state.mastery : "not assessed"}. ` +
              `${need} prerequisite${need === 1 ? "" : "s"}, unlocks ${opens}.`,
          };
        }),
        edges: graph.edges.map((e) =>
          toFlowEdge(
            e,
            Boolean(visible) && !(visible!.has(e.source) && visible!.has(e.target)),
            nameOf.get(e.source) ?? e.source,
            nameOf.get(e.target) ?? e.target,
          ),
        ),
      });
      setLayingOut(false);

      requestAnimationFrame(() => {
        if (!cancelled && graph.nodes.length > 0) void fitView(FIT);
      });
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, mode, fitView]); // Adding visible/focusId/selectedNodeId here relayouts on every hop

  useEffect(() => {
    setLayout((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            nodes: prev.nodes.map((n) => {
              const dimmed = visible ? !visible.has(n.id) : false;
              return {
                ...n,
                selected: n.id === selectedNodeId,
                focusable: !dimmed,
                selectable: !dimmed,
                data: { ...(n.data as ConceptNodeData), dimmed, isFocus: n.id === focusId },
              };
            }),
            edges: prev.edges.map((e) => ({
              ...e,
              style: {
                ...e.style,
                opacity: visible && !(visible.has(e.source) && visible.has(e.target)) ? 0.08 : 1,
              },
            })),
          },
    );
  }, [visible, focusId, selectedNodeId]);

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedNodeId;

  const hopTo = useCallback(
    (id: string, opts: { keepFocus?: boolean } = {}) => {
      if (selectedRef.current === id) return;
      if (opts.keepFocus) keepCanvasFocus.current = true;
      setSelection({ kind: "node", id }, { push: true });
      setTrail((t) => {
        const at = t.lastIndexOf(id);
        return at >= 0 ? t.slice(0, at + 1) : [...t, id];
      });
    },
    [setSelection],
  );

  const onCanvasKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const g = graph;
    if (!g) return;
    const commit = event.key === "Enter" || event.key === " ";
    if (!commit && !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const el = (event.target as HTMLElement).closest?.(".react-flow__node") as HTMLElement | null;
    const from = el?.dataset.id;
    if (!from) return;

    if (commit) {
      // Space on a focused node would otherwise scroll the page under the canvas
      event.preventDefault();
      if (from === selectedRef.current) headingRef.current?.focus();
      else hopTo(from);
      return;
    }

    const allowed = (id: string) => (visible ? visible.has(id) : true);
    const up = g.edges.filter((e) => e.target === from).map((e) => e.source).filter(allowed);
    const down = g.edges.filter((e) => e.source === from).map((e) => e.target).filter(allowed);

    let next: string | undefined;
    if (event.key === "ArrowUp") next = up[0];
    else if (event.key === "ArrowDown") next = down[0];
    else {
      const parent = up[0];
      const peers = (
        parent
          ? g.edges.filter((e) => e.source === parent).map((e) => e.target)
          : g.nodes.map((n) => n.id)
      ).filter(allowed);
      const at = peers.indexOf(from);
      if (at >= 0 && peers.length > 1) {
        const step = event.key === "ArrowRight" ? 1 : -1;
        next = peers[(at + step + peers.length) % peers.length];
      }
    }
    if (!next || next === from) return;

    event.preventDefault();
    hopTo(next, { keepFocus: true });
    const target = next;
    requestAnimationFrame(() => {
      const candidates = canvasRef.current?.querySelectorAll<HTMLElement>(".react-flow__node");
      for (const candidate of candidates ?? []) {
        if (candidate.dataset.id === target) { candidate.focus(); return; }
      }
    });
  };

  /** React reuses the inspector element, so reset scroll and focus per selection */
  useEffect(() => {
    inspectorRef.current?.scrollTo({ top: 0 });
    if (!mounted.current) { mounted.current = true; return; }
    if (keepCanvasFocus.current) { keepCanvasFocus.current = false; return; }
    if (!selection) return;
    headingRef.current?.focus();
  }, [selection?.kind, selection?.id]);

  const counts = graph
    ? {
        nodes: graph.nodes.length,
        hard: graph.edges.filter((e) => e.strength === "hard").length,
        soft: graph.edges.filter((e) => e.strength !== "hard").length,
      }
    : null;

  const nodes = layout && layout.mode === mode ? layout.nodes : NO_NODES;
  const edges = layout && layout.mode === mode ? layout.edges : NO_EDGES;
  const legend = <Legend mode={mode} hasLearner={Boolean(learnerId)} counts={counts} />;

  return (
    <div className="page flush graph-page">
      <h2 className="sr-only">Concept graph</h2>
      {/* A grid, not a wrapping row: a flex spacer collapses inside a wrap container */}
      <div className="toolbar graph-toolbar">
        <div className="gt-filters">
          <label className="field">
            view
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              <option value="explore">Explore</option>
              <option value="teach">Teach</option>
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
              {learners.map((l) => <option key={l.id} value={l.id}>{l.email ?? l.name ?? l.id}</option>)}
            </select>
          </label>
        </div>

        <div className="gt-status">
          <button onClick={() => void load()} aria-disabled={loading}>reload</button>
          {loading && graph && <Busy label="refreshing" clock={false} />}
          <span className={live ? "live" : "live off"} title={
            live
              ? "Checks every 3s for changes made elsewhere — a graph expansion finishing, " +
                "or mastery moving after a lesson or an assessment — and redraws when it finds one."
              : "Not watching for changes. The view only updates when you press reload."
          }>
            <span className="pulse" />
            <button className="live-toggle" aria-pressed={live} onClick={() => setLive((v) => !v)}>
              {live
                ? refreshedAt
                  ? `auto-refresh · updated ${clockTime(refreshedAt)}`
                  : "auto-refresh"
                : "auto-refresh off"}
            </button>
          </span>
        </div>

        {narrow ? (
          <details className="gt-legend gt-legend--fold">
            <summary>key{counts ? ` · ${counts.nodes} concepts` : ""}</summary>
            {legend}
          </details>
        ) : (
          <div className="gt-legend">{legend}</div>
        )}
      </div>

      {(focusDropped || refreshError) && (
        <div className="graph-notices">
          {focusDropped && (
            <div className="notice notice--warn">
              <p>
                The focused concept is not in this view, so the focus was cleared. It may
                have been removed, or it may sit outside the current topic filter.
              </p>
              <div className="row">
                {topicId && (
                  <button className="linkish" onClick={() => setTopicId("")}>
                    Show all topics
                  </button>
                )}
                <button className="linkish" onClick={() => setFocusDropped(false)}>
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {refreshError && (
            <div className="notice notice--error" role="alert">
              <strong>The graph could not be refreshed.</strong>
              <p>{refreshError.message} You are looking at the last version that loaded.</p>
              {refreshError.remedy && <p>{refreshError.remedy}</p>}
              <div className="row">
                <button onClick={() => void load()} aria-disabled={loading}>Retry</button>
                {loading && <Busy label="retrying" clock={false} />}
                <button className="linkish" onClick={() => setRefreshError(null)}>Dismiss</button>
              </div>
            </div>
          )}
        </div>
      )}

      {firstLoadError ? (
        <div className="page page--measure">
          <div className="notice notice--error" role="alert">
            <strong>The graph could not be loaded.</strong>
            <p>{firstLoadError.message}</p>
            {firstLoadError instanceof HttpError && firstLoadError.remedy && (
              <p>{firstLoadError.remedy}</p>
            )}
            <div className="row">
              <button onClick={() => void load()} aria-disabled={loading}>Try again</button>
              {loading && <Busy label="loading the graph" />}
            </div>
          </div>
        </div>
      ) : (
        <div className="graph-wrap">
          <div className="canvas" ref={canvasRef} onKeyDown={onCanvasKeyDown}>
            {!graph ? (
              <div className="canvas-loading" aria-busy="true">
                <div className="skeleton canvas-skeleton" />
                <Busy label="loading the graph" block />
              </div>
            ) : graph.nodes.length === 0 ? (
              <div className="page">
                <div className="empty">
                  {topicId ? (
                    <>
                      <p>
                        No concepts are tagged with this topic yet — which is a filter
                        result, not an empty database.
                      </p>
                      <div className="row empty-action">
                        <button onClick={() => setTopicId("")}>Show all topics</button>
                      </div>
                    </>
                  ) : (
                    <p>
                      No concepts yet. Run <code>pnpm --filter @kg/api seed</code>, or
                      expand a topic from Curate.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <>
                {focusNode && (
                  <div className="focus-bar panel panel--tight">
                    <span className="eyebrow">focused on</span>
                    <strong className="focus-name">{focusNode.name}</strong>
                    <label className="field">
                      depth
                      <select value={hops} onChange={(e) => setHops(Number(e.target.value))}>
                        <option value={1}>1 hop</option>
                        <option value={2}>2 hops</option>
                        <option value={3}>3 hops</option>
                      </select>
                    </label>
                    <span className="mono muted">
                      {visible?.size ?? 0} of {graph.nodes.length}
                    </span>
                    <button onClick={() => setFocusId(null)}>Show all</button>
                  </div>
                )}
                {layingOut && (
                  <div className="canvas-veil">
                    <Busy label="laying out the graph" clock={false} block />
                  </div>
                )}
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodeClick={(_, n) => hopTo(n.id)}
                  onEdgeClick={(_, e) => setSelection({ kind: "edge", id: e.id })}
                  onPaneClick={() => { setSelection(null); setTrail([]); }}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  // Edges would be unlabelled tab stops; the inspector exposes them as text
                  edgesFocusable={false}
                  deleteKeyCode={null}
                  fitView
                  fitViewOptions={FIT}
                  minZoom={0.15}
                  maxZoom={2.5}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background gap={20} size={1} color="var(--rule)" />
                  <Controls showInteractive={false} />
                  <MiniMap
                    pannable
                    zoomable
                    nodeColor={miniMapColor}
                    nodeStrokeColor="var(--rule-strong)"
                    nodeStrokeWidth={2}
                  />
                </ReactFlow>
              </>
            )}
          </div>
          <aside className="inspector" ref={inspectorRef} aria-label="concept detail">
            {graph ? (
              <Inspector
                graph={graph}
                selection={selection}
                trail={trail}
                onHop={hopTo}
                onFocus={setFocusId}
                focusId={focusId}
                learnerId={learnerId}
                onStateChanged={load}
                headingRef={headingRef}
              />
            ) : (
              <div className="stack" aria-busy="true">
                <div className="skeleton skeleton--line skeleton--w60" />
                <div className="skeleton skeleton--line skeleton--w80" />
                <div className="skeleton skeleton--line" />
                <div className="skeleton skeleton--line skeleton--w40" />
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function miniMapColor(node: Node): string {
  const d = node.data as ConceptNodeData;
  return d.mastery ? `var(--m-${d.mastery})` : "transparent";
}

function toFlowEdge(e: GraphEdge, dim: boolean, sourceName: string, targetName: string): Edge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    interactionWidth: 18,
    ariaLabel: `${sourceName} is a ${e.strength} prerequisite of ${targetName}`,
    focusable: false,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 16,
      height: 16,
      color: e.provisional ? "var(--accent)" : "var(--ink-soft)",
    },
    style: {
      stroke: e.provisional ? "var(--accent)" : "var(--rule-strong)",
      strokeWidth: e.strength === "hard" ? 1.8 : 1.2,
      strokeDasharray: e.strength === "soft" ? "4 3" : undefined,
      opacity: dim ? 0.08 : 1,
    },
  };
}
