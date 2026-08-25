import { useCallback, useEffect, useState } from "react";
import { api, type Mastery } from "../api";

const DOT: Record<Mastery, string> = {
  unknown: "var(--m-unknown)", familiar: "var(--m-familiar)",
  functional: "var(--m-functional)", solid: "var(--m-solid)",
};

/**
 * Expanding a new topic. This was the missing loop: the endpoint existed but nothing in
 * the UI reached it, so the graph could only grow from a seed or a curl. A learner
 * typing "React" is the whole premise of the product.
 */
function NewTopic({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [job, setJob] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job || job.status === "done" || job.status === "failed") return;
    const timer = setInterval(async () => {
      try {
        const j = await api.expansion(job.id);
        setJob(j);
        if (j.status === "done") onDone();
      } catch { /* transient */ }
    }, 2000);
    return () => clearInterval(timer);
  }, [job, onDone]);

  const start = async () => {
    setError(null);
    try { setJob(await api.startExpansion(name.trim())); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const running = job && (job.status === "queued" || job.status === "running");

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="k">Learn something new</div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          style={{ flex: 1 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !running) void start(); }}
          placeholder="A topic that isn't in the graph yet — e.g. React, SQL, recursion"
          disabled={!!running}
        />
        <button className="primary" onClick={() => void start()} disabled={!name.trim() || !!running}>
          {running ? "Building…" : "Build the graph"}
        </button>
      </div>

      {running && (
        <div style={{ marginTop: 10 }}>
          <div className="progress"><div className="bar" style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
          <div className="sub">
            {job.phase} · {Math.round(job.progress * 100)}%
            {" — this makes dozens of model calls and takes a few minutes."}
          </div>
        </div>
      )}
      {job?.status === "done" && (
        <div className="sub" style={{ marginTop: 8 }}>
          Built <strong>{job.topicName}</strong>: {job.report?.conceptsCreated ?? 0} new concepts,{" "}
          {job.report?.conceptsBound ?? 0} reused, {job.report?.edgesWritten ?? 0} edges
          {job.report?.edgesDemoted ? `, ${job.report.edgesDemoted} demoted to soft` : ""}
          {job.report?.conceptsDroppedByConsensus?.length
            ? ` · dropped by consensus: ${job.report.conceptsDroppedByConsensus.join(", ")}`
            : ""}
          . Pick it as a topic below.
        </div>
      )}
      {job?.status === "failed" && <div className="sub err" style={{ marginTop: 8 }}>{job.error}</div>}
      {error && <div className="sub err" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

export function LearnerPage() {
  const [learners, setLearners] = useState<any[]>([]);
  const [topics, setTopics] = useState<any[]>([]);
  const [id, setId] = useState("");
  const [state, setState] = useState<any>(null);
  const [plan, setPlan] = useState<any>(null);
  const [depth, setDepth] = useState("use");
  const [topicId, setTopicId] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void api.learners().then((l) => { setLearners(l); if (l[0]) setId(l[0].id); });
    void api.topics().then((t) => { setTopics(t); if (t[0]) setTopicId(t[0].id); });
  }, []);

  const load = useCallback(async (learnerId: string) => {
    if (!learnerId) return;
    setState(await api.learnerState(learnerId));
    try { setPlan(await api.plan(learnerId)); } catch { setPlan(null); }
  }, []);

  useEffect(() => { void load(id); }, [id, load]);

  const setGoal = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await api.setGoal(id, topicId, depth);
      setNote(`Plan v${r.plan.version}: ${r.plan.steps.length} concepts, ${r.plan.milestones.length} milestones`);
      await load(id);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const rebuild = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await api.rebuildPlan(id);
      // Growth is stated plainly rather than silently moving progress backwards. (08)
      setNote(`Plan v${r.version} — ${r.revisionReason ?? "no change"}`);
      await load(id);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const refreshTopics = useCallback(() => { void api.topics().then(setTopics); }, []);

  return (
    <div className="page">
      <NewTopic onDone={refreshTopics} />
      <div className="toolbar" style={{ marginBottom: 18, borderRadius: 6, border: "1px solid var(--rule)" }}>
        <label className="field">
          learner
          <select value={id} onChange={(e) => setId(e.target.value)}>
            {learners.map((l) => <option key={l.id} value={l.id}>{l.email}</option>)}
          </select>
        </label>
        <label className="field">
          topic
          <select value={topicId} onChange={(e) => setTopicId(e.target.value)}>
            {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="field">
          depth
          <select value={depth} onChange={(e) => setDepth(e.target.value)}>
            <option value="use">use</option>
            <option value="debug">debug</option>
            <option value="build">build</option>
          </select>
        </label>
        <button className="primary" onClick={() => void setGoal()} disabled={busy || !id}>
          Set goal &amp; plan
        </button>
        <button onClick={() => void rebuild()} disabled={busy || !plan}>Replan</button>
        {state?.learner && <span className="badge">arm: {state.learner.variant}</span>}
      </div>

      {note && <div className="banner">{note}</div>}

      {plan ? (
        <>
          <h2 className="section-title">
            Path — {plan.goal.topic} <span className="muted mono">({plan.goal.depth}, v{plan.version})</span>
          </h2>
          {plan.revisionReason && (
            <p className="muted" style={{ marginTop: 0 }}>Last change: {plan.revisionReason}</p>
          )}

          {plan.milestones.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              {plan.milestones.map((m: any) => (
                <div className="milestone" key={m.id}>
                  <div className="claim">{m.claim}</div>
                  <div className="note">
                    {m.conceptCount} concepts
                    {m.foldedForward && " · mostly already satisfied, folded into the next one"}
                    {m.completed && " · complete"}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="steps">
            {plan.steps.map((s: any) => (
              <div className={`step${s.committed ? " committed" : ""}`} key={s.conceptId}>
                <span className="pos">{String(s.position + 1).padStart(2, "0")}</span>
                <span>
                  <span className="mdot" style={{ background: DOT[s.currentMastery as Mastery], marginRight: 7 }} />
                  {s.name}
                  <span className="why" style={{ marginLeft: 8 }}>
                    needs {s.requiredLevel}
                    {s.unlockCount > 0 && ` · unlocks ${s.unlockCount}`}
                    {s.committed && " · committed"}
                  </span>
                </span>
                <span className="muted mono">{s.currentMastery}</span>
              </div>
            ))}
          </div>

          {plan.probes.length > 0 && (
            <>
              <h2 className="section-title">Probes due before the next step</h2>
              <table>
                <thead><tr><th>Concept</th><th>Kind</th><th>Why</th></tr></thead>
                <tbody>
                  {plan.probes.map((p: any) => (
                    <tr key={p.conceptId}>
                      <td>{p.name}</td>
                      <td className="mono">{p.kind}{p.optional ? "" : " (required)"}</td>
                      <td className="muted">{p.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      ) : (
        <div className="empty">No active plan. Pick a topic and depth, then set a goal.</div>
      )}

      {state && (
        <>
          <h2 className="section-title">Known concepts ({state.states.length})</h2>
          {state.states.length === 0 ? (
            <div className="empty">Nothing recorded yet.</div>
          ) : (
            <table>
              <thead>
                <tr><th>Concept</th><th>Mastery</th><th>Confidence</th><th>Source</th><th>Flags</th></tr>
              </thead>
              <tbody>
                {state.states.map((s: any) => (
                  <tr key={s.conceptId}>
                    <td>{s.name}</td>
                    <td>
                      <span className="mdot" style={{ background: DOT[s.mastery as Mastery], marginRight: 6 }} />
                      {s.mastery}
                    </td>
                    <td className="mono">{s.confidence.toFixed(2)}</td>
                    <td className="mono muted">{s.source}</td>
                    <td className="muted mono">
                      {s.reprobeQueued && "re-probe "}{s.blockedUntil && "blocked"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {state.misconceptions.length > 0 && (
            <>
              <h2 className="section-title">Misconceptions</h2>
              <table>
                <thead><tr><th>Concept</th><th>Belief</th><th>Matched failure mode</th></tr></thead>
                <tbody>
                  {state.misconceptions.map((m: any, i: number) => (
                    <tr key={i}>
                      <td>{m.name}</td>
                      <td>{m.belief}</td>
                      <td className="muted">{m.matchedFailureMode ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
