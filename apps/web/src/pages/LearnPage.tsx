import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

type Turn =
  | { role: "system"; text: string }
  | { role: "tutor"; text: string; kind?: "hook" | "explanation" | "example" | "verdict" }
  | { role: "learner"; text: string }
  | { role: "question"; text: string; itemId: string; requiresTransfer: boolean }
  | { role: "note"; text: string };

export function LearnPage() {
  const [learners, setLearners] = useState<any[]>([]);
  const [learnerId, setLearnerId] = useState("");
  const [plan, setPlan] = useState<any>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ itemId: string; prompt: string; requiresTransfer: boolean } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.learners().then((l) => { setLearners(l); if (l[0]) setLearnerId(l[0].id); });
  }, []);

  const loadPlan = useCallback(async (id: string) => {
    if (!id) return;
    try { setPlan(await api.plan(id)); } catch { setPlan(null); }
  }, []);
  useEffect(() => { void loadPlan(learnerId); }, [learnerId, loadPlan]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [turns]);

  const current = plan?.steps?.find((s: any) => !s.completed) ?? null;

  const push = (t: Turn) => setTurns((prev) => [...prev, t]);

  const teach = async () => {
    if (!current) return;
    setBusy("explaining"); setError(null); setPending(null);
    try {
      const e = await api.explain(learnerId, current.conceptId);
      setTurns([
        { role: "system", text: `Now teaching: ${e.concept.name}` },
        { role: "tutor", text: e.hook, kind: "hook" },
        { role: "tutor", text: e.explanation, kind: "explanation" },
        { role: "tutor", text: e.example, kind: "example" },
      ]);
      setBusy("finding a check");
      const c = await api.check(learnerId, current.conceptId, current.requiredLevel);
      setPending({ itemId: c.itemId, prompt: c.prompt, requiresTransfer: c.requiresTransfer });
      push({ role: "question", text: c.prompt, itemId: c.itemId, requiresTransfer: c.requiresTransfer });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !current) return;
    setInput(""); setError(null);
    push({ role: "learner", text });

    // An answer to a live check is graded; anything else is a question and gets routed.
    if (pending) {
      setBusy("grading");
      try {
        const r = await api.attempt(learnerId, {
          conceptId: current.conceptId,
          prompt: pending.prompt,
          response: text,
          requiresTransfer: pending.requiresTransfer,
          itemId: pending.itemId,
        });
        setPending(null);
        push({
          role: "tutor",
          kind: "verdict",
          text: r.grade.correct
            ? `Correct. ${r.grade.reasoning}`
            : `Not quite. ${r.grade.reasoning}`,
        });
        push({
          role: "note",
          text:
            `evidence: ${r.evidenceKind} · mastery ${r.state.before.mastery} → ${r.state.after.mastery}` +
            ` · next: ${r.action.kind.replace(/_/g, " ")}` +
            (r.propagatedTo.length ? ` · credited ${r.propagatedTo.length} prerequisite(s)` : ""),
        });
        await loadPlan(learnerId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally { setBusy(null); }
      return;
    }

    setBusy("thinking");
    try {
      const r = await api.ask(learnerId, current.conceptId, text);
      push({ role: "tutor", text: r.answer });
      push({
        role: "note",
        text:
          `routed as ${r.intent.replace(/_/g, " ")}` +
          (r.intent === "prerequisite_gap"
            ? " · recorded as a spontaneous prerequisite request — the cleanest missing-edge signal there is"
            : r.intent === "tangential"
              ? " · not taught, and no mastery recorded"
              : ""),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  return (
    <div className="page flush lesson">
      <div className="lesson-main">
        <div className="chat">
          {turns.length === 0 && (
            <div className="empty" style={{ margin: 24 }}>
              {current
                ? <>Next up: <strong>{current.name}</strong>. Start the lesson, then ask anything.</>
                : "No active plan. Set a goal on the Learner tab first."}
            </div>
          )}
          {turns.map((t, i) => (
            <div className={`turn ${t.role}`} key={i}>
              {t.role === "question" && <div className="q-label">
                check{t.requiresTransfer ? " · new context, recall will not do" : ""}
              </div>}
              <div className="bubble">{t.text}</div>
            </div>
          ))}
          {busy && <div className="turn note"><div className="bubble">{busy}…</div></div>}
          {error && <div className="turn note"><div className="bubble err">{error}</div></div>}
          <div ref={bottom} />
        </div>

        <div className="composer">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) void send(); }}
            placeholder={
              pending ? "Answer the check — or ask something instead" : "Ask a question…"
            }
            disabled={!current || !!busy}
          />
          <button className="primary" onClick={() => void send()} disabled={!current || !!busy || !input.trim()}>
            Send
          </button>
          <button onClick={() => void teach()} disabled={!current || !!busy}>
            {turns.length === 0 ? "Start lesson" : "Re-explain"}
          </button>
        </div>
      </div>

      <aside className="inspector">
        <label className="field" style={{ marginBottom: 14 }}>
          learner
          <select value={learnerId} onChange={(e) => setLearnerId(e.target.value)}>
            {learners.map((l) => <option key={l.id} value={l.id}>{l.email}</option>)}
          </select>
        </label>

        {plan ? (
          <>
            <section>
              <h4>Goal</h4>
              <div className="rel">{plan.goal.topic} <span className="muted mono">({plan.goal.depth})</span></div>
            </section>
            <section>
              <h4>Path</h4>
              {plan.steps.map((s: any) => (
                <div className="rel" key={s.conceptId} style={{ opacity: s.completed ? 0.5 : 1 }}>
                  <strong style={{ color: s === current ? "var(--accent)" : undefined }}>
                    {s.position + 1}. {s.name}
                  </strong>
                  <div className="fm">
                    {s.currentMastery} → needs {s.requiredLevel}
                    {s.committed && " · committed"}
                  </div>
                </div>
              ))}
            </section>
            {plan.probes.length > 0 && (
              <section>
                <h4>Probes due</h4>
                {plan.probes.map((p: any) => (
                  <div className="rel" key={p.conceptId}>
                    {p.name} <span className="muted mono">{p.optional ? "review" : "required"}</span>
                  </div>
                ))}
              </section>
            )}
          </>
        ) : (
          <p className="muted">No plan. Set a goal on the Learner tab.</p>
        )}
      </aside>
    </div>
  );
}
