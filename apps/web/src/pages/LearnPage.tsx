import { useCallback, useEffect, useRef, useState } from "react";
import { api, askStream } from "../api";
import { Elapsed } from "../components/Elapsed";
import { Markdown } from "../components/Markdown";
import { Intake } from "../components/Intake";
import { Widget } from "../widget/Widget";
import { Roadmap } from "../components/Roadmap";

interface Turn {
  role: string;
  text: string;
  meta?: {
    kind?: string; itemId?: string; requiresTransfer?: boolean;
    intent?: string; language?: string; spec?: unknown; goalText?: string;
    streaming?: boolean; code?: string | null; codeLanguage?: string | null;
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
  const [sessions, setSessions] = useState<any[]>([]);
  const [viewingSession, setViewingSession] = useState<string | null>(null);
  const [topics, setTopics] = useState<any[]>([]);
  const [showIntake, setShowIntake] = useState(false);
  const [intakeGoal, setIntakeGoal] = useState<string | null>(null);
  const [override, setOverride] = useState<{ conceptId: string; name: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.learners().then((l) => { setLearners(l); if (l[0]) setLearnerId(l[0].id); });
    void api.topics().then(setTopics);
  }, []);

  const load = useCallback(async (id: string): Promise<any> => {
    if (!id) return null;
    void api.sessions(id).then(setSessions).catch(() => undefined);
    // Returned as well as stored: a caller that needs to act on the fresh plan cannot
    // read it out of state yet, and reading the stale one starts the wrong lesson.
    let loaded: any = null;
    try { loaded = await api.plan(id); setPlan(loaded); } catch { setPlan(null); }
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
    return loaded;
  }, []);

  useEffect(() => { void load(learnerId); setViewingSession(null); }, [learnerId, load]);

  /**
   * Progress only. `load` also replaces the transcript, which is right when switching
   * learner or opening a past session and wrong in the middle of one: it discarded every
   * turn the page was holding and redrew the conversation as the server last saw it.
   */
  const refreshPlan = useCallback(async (id: string) => {
    if (!id) return;
    try { setPlan(await api.plan(id)); } catch { /* keep the plan we have */ }
  }, []);

  /**
   * An interrupted assessment should present itself, not wait behind a button. It was
   * resumable but invisible, which for the learner is the same as being lost.
   */
  useEffect(() => {
    if (!learnerId) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.openIntake(learnerId);
        if (!cancelled && r?.intake) { setShowIntake(true); return; }
      } catch { /* fall through */ }
      // A graph build in flight counts too. It runs for minutes, and if this page does
      // not open the assessment component there is nothing on screen to reattach to it
      // — the build finishes unobserved and the learner is left where they started.
      try {
        const jobs = await api.expansions();
        if (cancelled) return;
        if (jobs.some((j: any) => j.status === "queued" || j.status === "running")) {
          setShowIntake(true);
        }
      } catch { /* nothing running */ }
    })();
    return () => { cancelled = true; };
  }, [learnerId]);

  /** Switching to a past session shows it read-only until it is resumed. */
  const openSession = async (id: string) => {
    setViewingSession(id);
    setPending(null); setDetour(null); setError(null);
    try {
      const t = await api.sessionTranscript(id);
      setTurns(t.turns ?? []);
      if (t.open) setViewingSession(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeSession = async (id: string) => {
    setBusy("deleting");
    try {
      const r = await api.deleteSession(id);
      if (id === viewingSession) setViewingSession(null);
      await load(learnerId);
      const t = await api.transcript(learnerId);
      setTurns(t.turns ?? []);
      push({
        role: "note",
        text: `session deleted · ${r.turnsDeleted} turns removed · ${r.evidenceKept} evidence events kept`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const clearSessions = async () => {
    setBusy("clearing");
    try {
      const r = await api.deleteAllSessions(learnerId);
      setTurns([]); setViewingSession(null); setPending(null);
      await load(learnerId);
      setError(null);
      push({
        role: "note",
        text: `${r.sessionsDeleted} sessions deleted · ${r.evidenceKept} evidence events kept, so nothing you learned was lost`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const resume = async (id: string) => {
    setBusy("resuming");
    try {
      await api.resumeSession(id);
      setViewingSession(null);
      await load(learnerId);
      const t = await api.transcript(learnerId);
      setTurns(t.turns ?? []);
    } finally { setBusy(null); }
  };
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
        meta: {
          itemId: c.itemId, requiresTransfer: c.requiresTransfer,
          code: c.code, codeLanguage: c.codeLanguage,
        },
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
        } catch (err) {
          // "Not yet at the required level" is the expected case and stays quiet.
          // Anything else is a real failure and was previously swallowed whole — which
          // is exactly how a broken request hid while plans silently stopped advancing.
          const message = err instanceof Error ? err.message : String(err);
          if (!/not yet at the required level/i.test(message)) {
            push({ role: "note", text: `could not advance the plan: ${message}` });
          }
        }
        await refreshPlan(learnerId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally { setBusy(null); }
      return;
    }

    setBusy("routing your question");
    let streamIndex = -1;
    let visualFor: string | null = null;

    await askStream(learnerId, current.conceptId, text, {
      // The bubble opens before routing lands, so tokens have somewhere to land as
      // they arrive. Creating it in onRouted meant every delta before that was dropped.
      onOpen: () => {
        setBusy(null);
        setTurns((prev) => {
          streamIndex = prev.length;
          return [...prev, { role: "tutor", text: "", meta: { streaming: true } }];
        });
      },
      onRouted: (r) => {
        setBusy(null);
        // Annotates the answer already on screen rather than deciding whether to show
        // one. An actionable intent adds the offer next to it.
        setTurns((prev) => {
          if (streamIndex < 0 || !prev[streamIndex]) return prev;
          const next = [...prev];
          next[streamIndex] = {
            ...next[streamIndex]!,
            meta: { ...next[streamIndex]!.meta, intent: r.intent },
          };
          return next;
        });
        if (r.action === "start_roadmap") {
          push({ role: "goal-offer", text: r.goalText ?? text, meta: { goalText: r.goalText } });
        } else {
          push({
            role: "note",
            text:
              `routed as ${String(r.intent).replace(/_/g, " ")}` +
              (r.intent === "prerequisite_gap"
                ? " · recorded as a spontaneous prerequisite request"
                : r.intent === "tangential" ? " · not taught, no mastery recorded" : ""),
          });
        }
        if (r.detourTo && r.namedConcept) setDetour({ conceptId: r.detourTo, name: r.namedConcept });
        if (r.suggestVisual) visualFor = text;
      },
      onDelta: (chunk) => {
        setTurns((prev) => {
          if (streamIndex < 0 || !prev[streamIndex]) return prev;
          const next = [...prev];
          next[streamIndex] = { ...next[streamIndex]!, text: next[streamIndex]!.text + chunk };
          return next;
        });
      },
      onDone: () => {
        setTurns((prev) => {
          if (streamIndex < 0 || !prev[streamIndex]) return prev;
          const next = [...prev];
          next[streamIndex] = {
            ...next[streamIndex]!,
            meta: { ...next[streamIndex]!.meta, streaming: false },
          };
          return next;
        });
        // Only after the text has landed, so the simulation is not competing with it.
        if (visualFor) void showMe(visualFor);
      },
      onFailed: (message) => { setError(message); setBusy(null); },
    });
    setBusy(null);
  };

  /**
   * An interactive example, on demand. Prose and a code block are static; sequencing —
   * which is most of what is hard about the event loop, recursion or async ordering —
   * only becomes obvious when the learner can step through it themselves.
   */
  const showMe = async (focus?: string) => {
    if (!current) return;
    setBusy("building an interactive example"); setError(null);
    try {
      const w = await api.widget(learnerId, current.conceptId, focus);
      push({ role: "widget", text: w.conceptName, meta: { spec: w.spec } });
    } catch (err) {
      // A failed widget is not a failed lesson.
      push({ role: "note", text: `could not build an interactive example: ${err instanceof Error ? err.message : String(err)}` });
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

  if (showIntake) {
    return (
      <div className="page">
        <Intake
          learnerId={learnerId}
          topics={topics}
          initialGoal={intakeGoal}
          onComplete={() => {
            setShowIntake(false);
            setIntakeGoal(null);
            // The summary says "Starting with X", and then nothing started: the learner
            // landed on the lesson page with a roadmap card and no lesson. Deliver the
            // thing that was just promised.
            void load(learnerId).then((fresh) => {
              push({ role: "roadmap", text: "" });
              const first = fresh?.steps?.find((st: any) => !st.completed);
              if (first) void teach(first.conceptId, first.name);
            });
          }}
        />
      </div>
    );
  }

  return (
    <div className="page flush lesson">
      <div className="lesson-main">
        <div className="chat">
          {turns.length === 0 && (
            <div className="empty" style={{ margin: 24 }}>
              {current ? (
                <>Next up: <strong>{current.name}</strong>. Start the lesson, then ask anything.</>
              ) : (
                <>
                  <p style={{ marginTop: 0 }}>No plan yet.</p>
                  <button className="primary" onClick={() => setShowIntake(true)}>
                    Tell me what you want to learn
                  </button>
                </>
              )}
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
                ) : t.role === "roadmap" ? (
                  <Roadmap
                    learnerId={learnerId}
                    onPick={(conceptId, name) => {
                      setOverride({ conceptId, name });
                      void teach(conceptId, name);
                    }}
                  />
                ) : t.role === "goal-offer" ? (
                  <div className="goal-offer">
                    <div>
                      That is a different subject from what you are on. I can build you a
                      real roadmap for <strong>{t.text}</strong> — assess where you
                      already are, then order it — rather than describing one.
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        className="primary"
                        onClick={() => { setIntakeGoal(t.text); setShowIntake(true); }}
                      >
                        Build it
                      </button>
                      <button onClick={() => void showMe(t.text)}>
                        Just explain it here
                      </button>
                    </div>
                  </div>
                ) : t.role === "widget" ? (
                  <Widget spec={t.meta?.spec} />
                ) : t.role === "code" ? (
                  // Code is never run through the markdown parser: a `#` comment would
                  // become a heading and indentation would be lost.
                  <pre className="code-block" data-lang={t.meta?.language || undefined}>
                    <code>{t.text}</code>
                  </pre>
                ) : (
                  <>
                    <Markdown text={t.text} />
                    {/* A question's snippet is a separate field, so its line breaks
                        survive instead of being collapsed by paragraph joining. */}
                    {t.meta?.code && (
                      <Markdown
                        text={`\`\`\`${t.meta.codeLanguage ?? ""}\n${t.meta.code}\n\`\`\``}
                      />
                    )}
                    {t.meta?.streaming && <span className="caret" aria-hidden="true" />}
                  </>
                )}
              </div>
            </div>
          ))}
          {busy && (
            <div className="turn note">
              <div className="bubble busy">
                <span className="spinner" aria-hidden="true" />
                {busy} <Elapsed />
              </div>
            </div>
          )}
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
          {viewingSession ? (
            <>
              <span className="muted" style={{ flex: 1, alignSelf: "center" }}>
                Viewing a past session. Resume it to continue.
              </span>
              <button className="primary" onClick={() => void resume(viewingSession)} disabled={!!busy}>
                Resume this session
              </button>
              <button onClick={() => void load(learnerId).then(() => setViewingSession(null))}>
                Back to current
              </button>
            </>
          ) : (
          <>
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
          <button
            onClick={() => void showMe(input.trim() || undefined)}
            disabled={!current || !!busy}
            title="Build an interactive example of this concept — or of whatever you have typed"
          >
            Show me
          </button>
          {turns.length > 0 && <button onClick={() => void reset()} disabled={!!busy}>Start over</button>}
          </>
          )}
        </div>
      </div>

      <aside className="inspector">
        <label className="field" style={{ marginBottom: 14 }}>
          learner
          <select value={learnerId} onChange={(e) => setLearnerId(e.target.value)}>
            {learners.map((l) => <option key={l.id} value={l.id}>{l.email}</option>)}
          </select>
        </label>

        <button style={{ width: "100%", marginBottom: 14 }} onClick={() => setShowIntake(true)}>
          New goal &amp; assessment
        </button>

        {sessions.length > 0 && (
          <section>
            <div className="section-head">
              <h4>Sessions ({sessions.length})</h4>
              <button
                className="linkish danger"
                onClick={() => {
                  if (confirm(`Delete all ${sessions.length} sessions? Transcripts go; what you learned stays.`)) {
                    void clearSessions();
                  }
                }}
                disabled={!!busy}
              >
                clear all
              </button>
            </div>
            <div className="session-list">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className={`session-item${
                    (viewingSession ?? sessions.find((x) => x.open)?.id) === s.id ? " on" : ""
                  }`}
                >
                  <button className="session-open" onClick={() => void openSession(s.id)}>
                    <span className="t">{s.title.replace(/^Now teaching: /, "")}</span>
                    <span className="s">
                      {new Date(s.startedAt).toLocaleString(undefined, {
                        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                      })}
                      {" · "}{s.turns} turns{s.open ? " · current" : ""}
                    </span>
                  </button>
                  <button
                    className="session-delete"
                    title="Delete this transcript. Mastery earned in it is kept."
                    onClick={() => {
                      if (confirm("Delete this session's transcript? What you learned in it is kept.")) {
                        void removeSession(s.id);
                      }
                    }}
                    disabled={!!busy}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {override && (
          <div className="banner" style={{ fontSize: 12 }}>
            On a detour to <strong>{override.name}</strong>.{" "}
            <button className="linkish" onClick={() => setOverride(null)}>back to the plan</button>
          </div>
        )}

        {plan ? (
          <>
            <section>
              <div className="section-head">
                <h4>Goal</h4>
                <button className="linkish" onClick={() => push({ role: "roadmap", text: "" })}>
                  show roadmap
                </button>
              </div>
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
