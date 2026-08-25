import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Markdown } from "../components/Markdown";

interface Turn {
  role: string;
  text: string;
  meta?: {
    kind?: string; itemId?: string; requiresTransfer?: boolean;
    intent?: string; language?: string;
  } | null;
}

export function LearnPage() {
  const [learners, setLearners] = useState<any[]>([]);
  const [learnerId, setLearnerId] = useState("");
  const [plan, setPlan] = useState<any>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ itemId: string; prompt: string; requiresTransfer: boolean } | null>(null);
  const [detour, setDetour] = useState<{ conceptId: string; name: string } | null>(null);
  const [override, setOverride] = useState<{ conceptId: string; name: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.learners().then((l) => { setLearners(l); if (l[0]) setLearnerId(l[0].id); });
  }, []);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    try { setPlan(await api.plan(id)); } catch { setPlan(null); }
    // Resume the open session rather than starting blank on every reload.
    try {
      const t = await api.transcript(id);
      setTurns(t.turns ?? []);
      const lastQ = [...(t.turns ?? [])].reverse().find((x: Turn) => x.role === "question");
      const answeredSince = (t.turns ?? []).some(
        (x: Turn, i: number) =>
          x.role === "learner" && i > (t.turns ?? []).lastIndexOf(lastQ as never),
      );
      setPending(
        lastQ && !answeredSince
          ? {
              itemId: lastQ.meta?.itemId ?? "",
              prompt: lastQ.text,
              requiresTransfer: lastQ.meta?.requiresTransfer ?? false,
            }
          : null,
      );
    } catch { setTurns([]); }
  }, []);

  useEffect(() => { void load(learnerId); }, [learnerId, load]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [turns, busy]);

  const planned = plan?.steps?.find((s: any) => !s.completed) ?? null;
  const current = override ?? (planned ? { conceptId: planned.conceptId, name: planned.name } : null);
  const push = (t: Turn) => setTurns((prev) => [...prev, t]);

  const teach = async (conceptId?: string, name?: string) => {
    const target = conceptId ?? current?.conceptId;
    if (!target) return;
    setBusy("preparing the explanation"); setError(null); setPending(null); setDetour(null);
    try {
      const e = await api.explain(learnerId, target);
      push({ role: "system", text: `Now teaching: ${e.concept.name}` });
      push({ role: "tutor", text: e.hook, meta: { kind: "hook" } });
      push({ role: "tutor", text: e.explanation, meta: { kind: "explanation" } });
      push({ role: "code", text: e.example.code, meta: { kind: "example", language: e.example.language } });
      push({ role: "tutor", text: e.example.walkthrough, meta: { kind: "walkthrough" } });

      setBusy("writing a check");
      const c = await api.check(learnerId, target, planned?.requiredLevel ?? "functional");
      setPending({ itemId: c.itemId, prompt: c.prompt, requiresTransfer: c.requiresTransfer });
      push({
        role: "question", text: c.prompt,
        meta: { itemId: c.itemId, requiresTransfer: c.requiresTransfer },
      });
      if (name) setOverride({ conceptId: target, name });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !current) return;
    setInput(""); setError(null);
    push({ role: "learner", text });

    if (pending) {
      setBusy("grading");
      try {
        const r = await api.attempt(learnerId, {
          conceptId: current.conceptId, prompt: pending.prompt, response: text,
          requiresTransfer: pending.requiresTransfer, itemId: pending.itemId,
        });
        setPending(null);
        push({
          role: "tutor",
          text: r.grade.correct ? `**Correct.** ${r.grade.reasoning}` : `**Not quite.** ${r.grade.reasoning}`,
        });
        push({
          role: "note",
          text:
            `evidence ${r.evidenceKind} · mastery ${r.state.before.mastery} → ${r.state.after.mastery}` +
            ` · next ${r.action.kind.replace(/_/g, " ")}` +
            (r.propagatedTo.length ? ` · credited ${r.propagatedTo.length} prerequisite(s)` : ""),
        });
        if (r.action.kind === "detour") {
          setDetour({
            conceptId: r.action.prerequisiteConceptId,
            name: r.action.prerequisiteName,
          });
        }
        // Advance only when evidence actually earned it; the server re-checks.
        try {
          const done = await api.completeStep(learnerId, current.conceptId);
          if (done.completedMilestones?.length) {
            push({ role: "system", text: `Milestone reached: ${done.completedMilestones.join("; ")}` });
          }
          setOverride(null);
        } catch { /* not yet at the required level; stay on this concept */ }
        await load(learnerId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally { setBusy(null); }
      return;
    }

    setBusy("thinking");
    try {
      const r = await api.ask(learnerId, current.conceptId, text);
      push({ role: "tutor", text: r.answer, meta: { intent: r.intent } });
      push({
        role: "note",
        text:
          `routed as ${r.intent.replace(/_/g, " ")}` +
          (r.intent === "prerequisite_gap"
            ? " · recorded as a spontaneous prerequisite request"
            : r.intent === "tangential" ? " · not taught, no mastery recorded" : ""),
      });
      if (r.detourTo && r.namedConcept) setDetour({ conceptId: r.detourTo, name: r.namedConcept });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const reset = async () => {
    // Guarded: without it, clicking "Start lesson" straight after "Start over" reopens
    // the old session before the reset commits, and the new lesson lands in it.
    setBusy("starting over");
    try {
      await api.resetLesson(learnerId);
      setTurns([]); setPending(null); setDetour(null); setOverride(null);
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
                : "No active plan. Set a goal on the Learner tab, or expand a new topic there."}
            </div>
          )}
          {turns.map((t, i) => (
            <div className={`turn ${t.role}`} key={i}>
              {t.role === "question" && (
                <div className="q-label">
                  check{t.meta?.requiresTransfer ? " · new context, recall will not do" : ""}
                </div>
              )}
              <div className="bubble">
                {t.role === "note" ? (
                  t.text
                ) : t.role === "code" ? (
                  // Code is never run through the markdown parser: a `#` comment would
                  // become a heading and indentation would be lost.
                  <pre className="code-block" data-lang={t.meta?.language || undefined}>
                    <code>{t.text}</code>
                  </pre>
                ) : (
                  <Markdown text={t.text} />
                )}
              </div>
            </div>
          ))}
          {busy && <div className="turn note"><div className="bubble">{busy}…</div></div>}
          {error && <div className="turn note"><div className="bubble err">{error}</div></div>}

          {detour && (
            <div className="detour">
              <div>
                You seem to be missing <strong>{detour.name}</strong>. Cover it first?
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="primary" onClick={() => void teach(detour.conceptId, detour.name)}>
                  Teach {detour.name}
                </button>
                <button onClick={() => setDetour(null)}>Stay here</button>
              </div>
            </div>
          )}
          <div ref={bottom} />
        </div>

        <div className="composer">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) void send(); }}
            placeholder={pending ? "Answer the check — or ask something instead" : "Ask a question…"}
            disabled={!current || !!busy}
          />
          <button className="primary" onClick={() => void send()} disabled={!current || !!busy || !input.trim()}>
            Send
          </button>
          <button onClick={() => void teach()} disabled={!current || !!busy}>
            {turns.length === 0 ? "Start lesson" : "Re-explain"}
          </button>
          {turns.length > 0 && <button onClick={() => void reset()} disabled={!!busy}>Start over</button>}
        </div>
      </div>

      <aside className="inspector">
        <label className="field" style={{ marginBottom: 14 }}>
          learner
          <select value={learnerId} onChange={(e) => setLearnerId(e.target.value)}>
            {learners.map((l) => <option key={l.id} value={l.id}>{l.email}</option>)}
          </select>
        </label>

        {override && (
          <div className="banner" style={{ fontSize: 12 }}>
            On a detour to <strong>{override.name}</strong>.{" "}
            <button className="linkish" onClick={() => setOverride(null)}>back to the plan</button>
          </div>
        )}

        {plan ? (
          <>
            <section>
              <h4>Goal</h4>
              <div className="rel">{plan.goal.topic} <span className="muted mono">({plan.goal.depth})</span></div>
            </section>
            <section>
              <h4>Path</h4>
              {plan.steps.map((s: any) => (
                <div className="rel" key={s.conceptId} style={{ opacity: s.completed ? 0.45 : 1 }}>
                  <strong style={{ color: s.conceptId === current?.conceptId ? "var(--accent)" : undefined }}>
                    {s.completed ? "✓ " : `${s.position + 1}. `}{s.name}
                  </strong>
                  <div className="fm">{s.currentMastery} → needs {s.requiredLevel}</div>
                </div>
              ))}
            </section>
            {plan.milestones.length > 0 && (
              <section>
                <h4>Milestones</h4>
                {plan.milestones.map((m: any) => (
                  <div className="rel" key={m.id} style={{ opacity: m.completed ? 0.5 : 1 }}>
                    {m.completed ? "✓ " : ""}{m.claim}
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
