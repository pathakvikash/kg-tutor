import { useCallback, useEffect, useState } from "react";
import { api, type Mastery } from "../api";

const DOT: Record<Mastery, string> = {
  unknown: "var(--m-unknown)", familiar: "var(--m-familiar)",
  functional: "var(--m-functional)", solid: "var(--m-solid)",
};

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

  return (
    <div className="page">
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
