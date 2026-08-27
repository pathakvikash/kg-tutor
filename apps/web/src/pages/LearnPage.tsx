import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, askStream, DUE_LIMIT, HttpError } from "../api";
import { Busy } from "../components/Busy";
import { Markdown } from "../components/Markdown";
import { Intake } from "../components/Intake";
import { Widget } from "../widget/Widget";
import { resolveLearner, useStickyLearner } from "../useLearner";
import { Roadmap } from "../components/Roadmap";
import { DEPTH_LABEL, MASTERY_MEANING } from "../vocabulary";
import type { Mastery } from "../api";

interface Turn {
  /** Server row id, present only on turns that came back from the transcript. */
  id?: string;
  /**
   * Stable client key. The streaming turn is found by this and never by its array
   * index: replacing `turns` mid-stream (opening a past session, a reset) used to
   * splice live tokens into whatever unrelated turn had inherited the index.
   */
  lid: string;
  createdAt?: string;
  role: string;
  text: string;
  meta?: {
    kind?: string; itemId?: string; requiresTransfer?: boolean;
    intent?: string; language?: string; spec?: unknown; goalText?: string;
    streaming?: boolean; stopped?: boolean; code?: string | null; codeLanguage?: string | null;
    /** Grade turns: matches the meta the server persists, so a reload renders the same. */
    correct?: boolean; chips?: string[];
    /** Splits the old catch-all .turn.note into progress the learner cares about and diagnostics. */
    note?: "progress" | "diag";
  } | null;
}

/** What is on screen, so "not asked yet" stops being drawn as "nothing here". */
type Phase = "loading" | "ready" | "failed";

interface Failure {
  title: string;
  message: string;
  remedy?: string | null;
  /** Bound to the operation that failed, so retrying does not mean guessing. */
  retry?: () => void;
  retryLabel?: string;
}

let lidSeq = 0;
const nextLid = () => `l${++lidSeq}`;

function failureOf(err: unknown): { message: string; remedy: string | null } {
  if (err instanceof HttpError) return { message: err.message, remedy: err.remedy };
  return { message: err instanceof Error ? err.message : String(err), remedy: null };
}

/**
 * Enough to offer a choice, never enough to decide.
 *
 * With a check open, whatever was typed was graded: permanent evidence, a mastery
 * write, sometimes a forced detour, and no undo — while the placeholder invited the
 * learner to ask something instead.
 */
function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (t.endsWith("?")) return true;
  return /^(what|why|how|when|where|which|who|can|could|do|does|did|is|are|should|would|will|explain|tell me|show me|i don'?t (get|understand))\b/i.test(t);
}

function relativeTime(iso?: string): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function LearnPage() {
  const [learnerId, setLearnerId] = useStickyLearner();
  const [phase, setPhase] = useState<Phase>("loading");
  const [plan, setPlan] = useState<any>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<{ label: string; step?: string } | null>(null);
  /**
   * Separate from `busy`: onOpen clears the label as soon as the first byte lands, so
   * for the bulk of a 3–40s answer the page used to consider itself idle and Enter sent
   * a second, overlapping request into the same transcript.
   */
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [pending, setPending] = useState<{ itemId: string; prompt: string; requiresTransfer: boolean } | null>(null);
  const [detour, setDetour] = useState<{ conceptId: string; name: string } | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [viewingSession, setViewingSession] = useState<string | null>(null);
  const [topics, setTopics] = useState<any[]>([]);
  const [showIntake, setShowIntake] = useState(false);
  const [intakeGoal, setIntakeGoal] = useState<string | null>(null);
  const [override, setOverride] = useState<{ conceptId: string; name: string } | null>(null);
  /** Held text that reads as a question while a check is open, awaiting the learner's call. */
  const [ambiguous, setAmbiguous] = useState<string | null>(null);
  const [due, setDue] = useState<number | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  /**
   * One token per operation. `askStream` and the api helpers take no AbortSignal, so
   * Stop cannot cut the request off; it can and does stop the answer being applied to
   * the page, which is what the learner asked for.
   */
  const op = useRef(0);
  const begin = () => ++op.current;
  const live = (token: number) => op.current === token;

  useEffect(() => {
    // No learner picker on this page any more — it lives on Home — but the page still
    // has to resolve the stored learner against the ones the server knows.
    void api.learners()
      .then((l) => setLearnerId(resolveLearner(learnerId, l)))
      .catch(() => undefined);
    void api.topics().then(setTopics).catch(() => undefined);
  }, []);

  const load = useCallback(async (id: string): Promise<any> => {
    if (!id) { setPhase("ready"); return null; }
    setPhase("loading"); setError(null);
    void api.sessions(id).then(setSessions).catch(() => undefined);
    // Returned as well as stored: a caller that needs to act on the fresh plan cannot
    // read it out of state yet, and reading the stale one starts the wrong lesson.
    let loaded: any = null;
    let broke: Failure | null = null;
    try { loaded = await api.plan(id); setPlan(loaded); }
    catch (err) {
      setPlan(null);
      // 404 is "no plan yet" — a real, confirmed empty state. Anything else means we
      // do not know what this learner has, and must not claim they have nothing.
      if (!(err instanceof HttpError && err.isMissing)) {
        broke = { title: "Your plan could not be loaded.", ...failureOf(err) };
      }
    }
    // Resume the open session rather than starting blank on every reload.
    try {
      const t = await api.transcript(id);
      const rows: Turn[] = (t.turns ?? []).map((x: any) => ({ ...x, lid: x.id ?? nextLid() }));
      setTurns(rows);
      const lastQ = [...rows].reverse().find((x) => x.role === "question");
      const answeredSince = rows.some(
        (x, i) => x.role === "learner" && i > rows.lastIndexOf(lastQ as never),
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
    } catch (err) {
      setTurns([]);
      if (!(err instanceof HttpError && err.isMissing)) {
        broke = broke ?? { title: "Your transcript could not be loaded.", ...failureOf(err) };
      }
    }
    if (broke) {
      setError({ ...broke, retryLabel: "Try again", retry: () => void load(id) });
      setPhase("failed");
    } else {
      setPhase("ready");
    }
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

  const planned = plan?.steps?.find((s: any) => !s.completed) ?? null;
  const current = override ?? (planned ? { conceptId: planned.conceptId, name: planned.name } : null);
  const readOnly = !!viewingSession;
  const locked = !!busy || streaming;
  /** Every step met. `current` is null here, so the whole composer would otherwise go inert. */
  const planComplete =
    phase === "ready" && !!plan && plan.steps.length > 0 &&
    plan.steps.every((s: any) => s.completed) && !override;

  useEffect(() => {
    if (!planComplete || !learnerId) { setDue(null); return; }
    let cancelled = false;
    void api.due(learnerId, DUE_LIMIT)
      .then((d) => { if (!cancelled) setDue(d.total ?? 0); })
      .catch(() => { if (!cancelled) setDue(null); });
    return () => { cancelled = true; };
  }, [planComplete, learnerId]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [turns, busy]);

  // Grows with what is typed, up to about six rows, then scrolls.
  useEffect(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [input]);

  const push = (t: Omit<Turn, "lid">) => setTurns((prev) => [...prev, { ...t, lid: nextLid() }]);
  const patch = (lid: string, fn: (t: Turn) => Turn) =>
    setTurns((prev) => {
      const i = prev.findIndex((t) => t.lid === lid);
      if (i < 0) return prev;
      const next = [...prev];
      next[i] = fn(next[i]!);
      return next;
    });

  /** Switching to a past session shows it read-only until it is resumed. */
  const openSession = async (id: string) => {
    if (locked) return;
    begin();
    setBusy(null); setStreaming(false);
    setViewingSession(id);
    setPending(null); setDetour(null); setError(null); setAmbiguous(null);
    try {
      const t = await api.sessionTranscript(id);
      setTurns((t.turns ?? []).map((x: any) => ({ ...x, lid: x.id ?? nextLid() })));
      if (t.open) setViewingSession(null);
    } catch (err) {
      setError({
        title: "That session could not be opened.", ...failureOf(err),
        retryLabel: "Try again", retry: () => void openSession(id),
      });
    }
  };

  const removeSession = async (id: string) => {
    if (locked) return;
    const token = begin();
    setBusy({ label: "deleting that transcript" });
    try {
      const r = await api.deleteSession(id);
      if (id === viewingSession) setViewingSession(null);
      await load(learnerId);
      if (!live(token)) return;
      push({
        role: "note",
        meta: { note: "progress" },
        text: `Session deleted · ${r.turnsDeleted} turns removed · ${r.evidenceKept} evidence events kept.`,
      });
    } catch (err) {
      if (!live(token)) return;
      setError({
        title: "That transcript was not deleted.", ...failureOf(err),
        retryLabel: "Try again", retry: () => void removeSession(id),
      });
    } finally { if (live(token)) setBusy(null); }
  };

  const clearSessions = async () => {
    if (locked) return;
    const token = begin();
    setBusy({ label: "deleting every transcript" });
    try {
      const r = await api.deleteAllSessions(learnerId);
      setTurns([]); setViewingSession(null); setPending(null);
      await load(learnerId);
      if (!live(token)) return;
      push({
        role: "note",
        meta: { note: "progress" },
        text: `${r.sessionsDeleted} sessions deleted · ${r.evidenceKept} evidence events kept, so nothing you learned was lost.`,
      });
    } catch (err) {
      if (!live(token)) return;
      setError({
        title: "The transcripts were not deleted.", ...failureOf(err),
        retryLabel: "Try again", retry: () => void clearSessions(),
      });
    } finally { if (live(token)) setBusy(null); }
  };

  const resume = async (id: string) => {
    if (locked) return;
    const token = begin();
    setBusy({ label: "reopening that session" });
    try {
      await api.resumeSession(id);
      setViewingSession(null);
      await load(learnerId);
    } catch (err) {
      if (!live(token)) return;
      setError({
        title: "That session could not be resumed.", ...failureOf(err),
        retryLabel: "Try again", retry: () => void resume(id),
      });
    } finally { if (live(token)) setBusy(null); }
  };

  const teach = async (conceptId?: string, name?: string) => {
    if (locked || readOnly) return;
    const target = conceptId ?? current?.conceptId;
    if (!target) return;
    const token = begin();
    // Two model calls, named separately: one label over both made a 60s wait look like
    // one hung request instead of two ordinary ones.
    setBusy({ label: "writing the explanation", step: "step 1 of 2" });
    setError(null); setPending(null); setDetour(null); setAmbiguous(null);
    try {
      const e = await api.explain(learnerId, target);
      if (!live(token)) return;
      push({ role: "system", text: `Now teaching: ${e.concept.name}` });
      push({ role: "tutor", text: e.hook, meta: { kind: "hook" } });
      push({ role: "tutor", text: e.explanation, meta: { kind: "explanation" } });
      push({ role: "code", text: e.example.code, meta: { kind: "example", language: e.example.language } });
      push({ role: "tutor", text: e.example.walkthrough, meta: { kind: "walkthrough" } });

      setBusy({ label: "writing a check on it", step: "step 2 of 2" });
      const c = await api.check(learnerId, target, planned?.requiredLevel ?? "functional");
      if (!live(token)) return;
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
      if (!live(token)) return;
      setError({
        title: "The lesson could not be prepared.", ...failureOf(err),
        retryLabel: "Try again", retry: () => void teach(conceptId, name),
      });
    } finally { if (live(token)) setBusy(null); }
  };

  /** The graded path. Everything here is permanent, so nothing reaches it by accident. */
  const grade = async (text: string) => {
    if (locked || readOnly || !current || !pending) return;
    const token = begin();
    const item = pending;
    const mine = nextLid();
    setAmbiguous(null); setError(null);
    setTurns((prev) => [...prev, { lid: mine, role: "learner", text }]);
    setBusy({ label: "grading your answer" });
    try {
      const r = await api.attempt(learnerId, {
        conceptId: current.conceptId, prompt: item.prompt, response: text,
        requiresTransfer: item.requiresTransfer, itemId: item.itemId,
      });
      if (!live(token)) return;
      setPending(null);
      push({
        role: "tutor",
        text: r.grade.correct ? `**Correct.** ${r.grade.reasoning}` : `**Not quite.** ${r.grade.reasoning}`,
        // Same shape the server persists for this turn, so a reload renders it the same way.
        meta: {
          kind: "grade", correct: r.grade.correct,
          chips: [
            `${r.state.before.mastery} → ${r.state.after.mastery}`,
            `confidence ${Number(r.state.after.confidence).toFixed(2)}`,
            String(r.evidenceKind).replace(/_/g, " "),
            `next ${String(r.action.kind).replace(/_/g, " ")}`,
            ...(r.propagatedTo.length ? [`credited ${r.propagatedTo.length} prerequisite(s)`] : []),
          ],
        },
      });
      if (r.action.kind === "detour") {
        setDetour({ conceptId: r.action.prerequisiteConceptId, name: r.action.prerequisiteName });
      }
      // Advance only when evidence actually earned it; the server re-checks.
      try {
        const done = await api.completeStep(learnerId, current.conceptId);
        if (done.completedMilestones?.length) {
          push({ role: "milestone", text: done.completedMilestones.join("; ") });
        }
        setOverride(null);
      } catch (err) {
        // "Not yet at the required level" is the expected case and stays quiet.
        // Anything else is a real failure and was previously swallowed whole — which
        // is exactly how a broken request hid while plans silently stopped advancing.
        const message = err instanceof Error ? err.message : String(err);
        if (!/not yet at the required level/i.test(message)) {
          push({ role: "note", meta: { note: "progress" }, text: `Could not advance the plan: ${message}` });
        }
      }
      await refreshPlan(learnerId);
    } catch (err) {
      if (!live(token)) return;
      // The grading never happened, so the answer goes back to being unsent: out of the
      // transcript, back in the composer, still the learner's own writing.
      setTurns((prev) => prev.filter((t) => t.lid !== mine));
      setInput(text);
      setError({
        title: "That answer was not graded.", ...failureOf(err),
        retryLabel: "Grade it again", retry: () => void grade(text),
      });
    } finally { if (live(token)) setBusy(null); }
  };

  /** The ungraded path. A check stays open across it — asking is not answering. */
  const ask = async (text: string) => {
    if (locked || readOnly || !current) return;
    const token = begin();
    setAmbiguous(null); setError(null);
    push({ role: "learner", text });
    setBusy({ label: "routing your question" });

    const streamLid = nextLid();
    let visualFor: string | null = null;

    try {
      await askStream(learnerId, current.conceptId, text, {
        // The bubble opens before routing lands, so tokens have somewhere to land as
        // they arrive. Creating it in onRouted meant every delta before that was dropped.
        onOpen: () => {
          if (!live(token)) return;
          setBusy(null); setStreaming(true);
          setTurns((prev) => [...prev, { lid: streamLid, role: "tutor", text: "", meta: { streaming: true } }]);
        },
        onRouted: (r) => {
          if (!live(token)) return;
          setBusy(null);
          // Annotates the answer already on screen rather than deciding whether to show
          // one. An actionable intent adds the offer next to it.
          patch(streamLid, (t) => ({ ...t, meta: { ...t.meta, intent: r.intent } }));
          if (r.action === "start_roadmap") {
            push({ role: "goal-offer", text: r.goalText ?? text, meta: { goalText: r.goalText } });
          } else {
            push({
              role: "note",
              meta: { note: "diag" },
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
          if (!live(token)) return;
          patch(streamLid, (t) => ({ ...t, text: t.text + chunk }));
        },
        onDone: () => {
          if (!live(token)) return;
          patch(streamLid, (t) => ({ ...t, meta: { ...t.meta, streaming: false } }));
          setStreaming(false);
          // Only after the text has landed, so the simulation is not competing with it.
          if (visualFor) void showMe(visualFor);
        },
        onFailed: (message) => {
          if (!live(token)) return;
          // An empty bubble with a blinking caret is worse than no bubble: it never
          // resolves. Partial text stays, labelled as cut short.
          setTurns((prev) => {
            const i = prev.findIndex((t) => t.lid === streamLid);
            if (i < 0) return prev;
            const t = prev[i]!;
            if (!t.text.trim()) return [...prev.slice(0, i), ...prev.slice(i + 1)];
            const next = [...prev];
            next[i] = { ...t, meta: { ...t.meta, streaming: false, stopped: true } };
            return next;
          });
          setStreaming(false);
          setError({
            title: "The answer failed.", message, remedy: null,
            retryLabel: "Ask again", retry: () => void ask(text),
          });
        },
      });
    } catch (err) {
      if (!live(token)) return;
      setError({
        title: "The answer failed.", ...failureOf(err),
        retryLabel: "Ask again", retry: () => void ask(text),
      });
    } finally {
      if (live(token)) { setBusy(null); setStreaming(false); }
    }
  };

  const send = () => {
    const text = input.trim();
    if (!text || !current || locked || readOnly) return;
    setInput("");
    // With a check open, a question that gets graded costs permanent evidence. The
    // placeholder offered both, so both are offered here rather than one being assumed.
    if (pending && looksLikeQuestion(text)) { setAmbiguous(text); return; }
    if (pending) { void grade(text); return; }
    void ask(text);
  };

  /** Session-local: the check itself stays on the server and returns on a reload. */
  const skipCheck = () => {
    if (locked || readOnly || !pending) return;
    setPending(null); setAmbiguous(null);
    push({ role: "note", meta: { note: "progress" }, text: "Check skipped. Nothing was recorded." });
  };

  const stop = () => {
    // No AbortSignal reaches the request, so this stops the page acting on the answer
    // rather than stopping the work. Named "Stop" because that is what it does here.
    begin();
    setBusy(null); setStreaming(false);
    setTurns((prev) =>
      prev.map((t) => (t.meta?.streaming ? { ...t, meta: { ...t.meta, streaming: false, stopped: true } } : t)),
    );
    push({ role: "note", meta: { note: "progress" }, text: "Stopped." });
  };

  /**
   * An interactive example, on demand. Prose and a code block are static; sequencing —
   * which is most of what is hard about the event loop, recursion or async ordering —
   * only becomes obvious when the learner can step through it themselves.
   */
  const showMe = async (focus?: string) => {
    if (!current || readOnly) return;
    const token = begin();
    setBusy({ label: "building an interactive example" }); setError(null);
    try {
      const w = await api.widget(learnerId, current.conceptId, focus);
      if (!live(token)) return;
      push({ role: "widget", text: w.conceptName, meta: { spec: w.spec } });
    } catch (err) {
      if (!live(token)) return;
      // A failed widget is not a failed lesson.
      push({
        role: "note", meta: { note: "progress" },
        text: `Could not build an interactive example: ${failureOf(err).message}`,
      });
    } finally { if (live(token)) setBusy(null); }
  };

  const reset = async () => {
    // Start over stays available while something is in flight: it is the way out of a
    // slow answer, so gating it on the slow answer is the wrong way round.
    const token = begin();
    setBusy({ label: "starting over" }); setStreaming(false);
    try {
      await api.resetLesson(learnerId);
      if (!live(token)) return;
      setTurns([]); setPending(null); setDetour(null); setOverride(null);
      setAmbiguous(null); setError(null);
      void api.sessions(learnerId).then(setSessions).catch(() => undefined);
    } catch (err) {
      if (!live(token)) return;
      setError({
        title: "The session was not reset.", ...failureOf(err),
        retryLabel: "Try again", retry: () => void reset(),
      });
    } finally { if (live(token)) setBusy(null); }
  };

  if (showIntake) {
    return (
      <div className="page">
        <Intake
          learnerId={learnerId}
          topics={topics}
          initialGoal={intakeGoal}
          onCancel={() => { setShowIntake(false); setIntakeGoal(null); }}
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

  const lessons = turns.filter((t) => t.role === "system");
  const stepCount = plan?.steps?.length ?? 0;
  const stepIndex = planned ? planned.position + 1 : stepCount;

  return (
    <div className="page flush lesson">
      <div className="lesson-main">
        {current && plan && (
          <div className="lesson-head">
            <div className="lesson-head-main">
              <h2 className="lesson-concept">{current.name}</h2>
              <div className="lesson-head-meta">
                {planned && (
                  <>
                    <span
                      className="mastery-mark"
                      data-level={(planned.currentMastery ?? "unknown") as Mastery}
                      aria-hidden="true"
                    />
                    <span>
                      {planned.currentMastery} → needs {planned.requiredLevel}
                    </span>
                    <span className="sep" aria-hidden="true">·</span>
                  </>
                )}
                <span>step {stepIndex} of {stepCount}</span>
                {override && <span className="pill pill--accent">detour</span>}
              </div>
            </div>
            {pending && !readOnly && <span className="pill pill--structure">check pending</span>}
            {readOnly && <span className="pill">read-only</span>}
          </div>
        )}

        <div className="chat" data-readonly={readOnly || undefined}>
          {readOnly && (
            <div className="notice notice--info chat-banner">
              <strong>A past session, read-only.</strong>
              Nothing here can be answered or added to. Resume it to carry on.
            </div>
          )}

          {phase === "loading" && (
            <div className="chat-loading">
              <Busy label="opening where you left off" clock={false} block />
              <div className="turn skeleton-turn" aria-hidden="true">
                <div className="skeleton skeleton--line skeleton--w40" />
                <div className="skeleton skeleton--line skeleton--w80" />
                <div className="skeleton skeleton--line skeleton--w60" />
              </div>
              <div className="turn skeleton-turn" aria-hidden="true">
                <div className="skeleton skeleton--line skeleton--w60" />
                <div className="skeleton skeleton--line skeleton--w80" />
              </div>
            </div>
          )}

          {phase === "ready" && turns.length === 0 && !planComplete && (
            <div className="chat-empty">
              {current ? (
                <p className="panel panel--dashed empty-line">
                  Next up: <strong>{current.name}</strong>. Start the lesson, then ask anything.
                </p>
              ) : (
                // Only reached when the server actually said this learner has no plan.
                <div className="panel panel--dashed stack">
                  <p className="empty-line">No plan yet — nothing has been set as a goal.</p>
                  <button className="primary" onClick={() => setShowIntake(true)}>
                    Tell me what you want to learn
                  </button>
                </div>
              )}
            </div>
          )}

          {turns.map((t) => {
            const stamp = relativeTime(t.createdAt);
            if (t.role === "system") {
              // A real heading: it is the one landmark in a long transcript, and the
              // jump-list in the inspector needs something to jump to.
              return (
                <div className="turn system" key={t.lid} id={`lesson-${t.lid}`}>
                  <h2 className="lesson-divider">
                    {t.text}
                    {stamp && <span className="turn-time">{stamp}</span>}
                  </h2>
                </div>
              );
            }
            if (t.role === "milestone") {
              return (
                <div className="turn milestone-turn" key={t.lid}>
                  <div className="notice notice--ok">
                    <strong>Milestone reached</strong>
                    {t.text}
                  </div>
                </div>
              );
            }
            if (t.role === "note") {
              return (
                <div className="turn note" data-note={t.meta?.note ?? "diag"} key={t.lid}>
                  <div className="bubble">{t.text}</div>
                </div>
              );
            }
            if (t.meta?.kind === "grade") {
              return (
                <div className="turn grade" key={t.lid}>
                  <div className={t.meta.correct ? "verdict ok" : "verdict gap"}>
                    <Markdown text={t.text} />
                    {t.meta.chips && t.meta.chips.length > 0 && (
                      <div className="chips">
                        {t.meta.chips.map((c) => <span className="chip" key={c}>{c}</span>)}
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div className={`turn ${t.role}`} data-kind={t.meta?.kind || undefined} key={t.lid}>
                {t.role === "question" && (
                  <div className="q-label">
                    check{t.meta?.requiresTransfer ? " · new context, recall will not do" : ""}
                  </div>
                )}
                <div className="bubble">
                  {t.role === "roadmap" ? (
                    <Roadmap
                      learnerId={learnerId}
                      // A past session is read-only, and this used to start a real lesson
                      // into the OPEN session while rendering it into the historical one.
                      onPick={readOnly ? undefined : (conceptId, name) => {
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
                      {!readOnly && (
                        <div className="row">
                          <button
                            className="primary"
                            onClick={() => { setIntakeGoal(t.text); setShowIntake(true); }}
                          >
                            Build it
                          </button>
                          <button onClick={() => void showMe(t.text)} aria-disabled={locked || undefined}>
                            Just explain it here
                          </button>
                        </div>
                      )}
                    </div>
                  ) : t.role === "widget" ? (
                    <Widget spec={t.meta?.spec} />
                  ) : t.role === "code" ? (
                    // Fenced and then rendered, so the lesson's primary example gets the
                    // same highlighting as the snippets below it. The fence is what keeps
                    // it safe: inside one, a `#` comment stays a comment.
                    <Markdown text={`\`\`\`${t.meta?.language ?? ""}\n${t.text}\n\`\`\``} />
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
                      {t.meta?.stopped && <p className="turn-stopped">the answer stopped early</p>}
                    </>
                  )}
                </div>
              </div>
            );
          })}

          {planComplete && (
            <div className="panel done-card stack">
              <p className="eyebrow">plan complete</p>
              <h2>{plan.goal.topic} — every step met</h2>
              <p className="done-sub">
                {stepCount} concept{stepCount === 1 ? "" : "s"} covered
                {plan.milestones.length > 0 && (
                  <>
                    {" · "}
                    {plan.milestones.filter((m: any) => m.completed).length} of{" "}
                    {plan.milestones.length} milestones claimed
                  </>
                )}
                {" · "}to {DEPTH_LABEL[plan.goal.depth]?.label.toLowerCase() ?? plan.goal.depth}
              </p>
              {plan.milestones.length > 0 && (
                <ul className="done-claims">
                  {plan.milestones.map((m: any) => (
                    <li key={m.id} data-claimed={m.completed || undefined}>{m.claim}</li>
                  ))}
                </ul>
              )}
              <p className="muted empty-line">
                Nothing here is finished for good — confidence fades, so what you proved
                comes back to be re-proved.
              </p>
              <div className="row">
                <Link className="btn primary" to="/review-session">
                  {due === null ? "Review what's due" : `Review what's due (${due})`}
                </Link>
                <button onClick={() => setShowIntake(true)}>Set a new goal</button>
                <button onClick={() => push({ role: "roadmap", text: "" })}>
                  Show the roadmap
                </button>
              </div>
            </div>
          )}

          {busy && (
            // key: the clock restarts per step, so elapsed time is attributable to the
            // step that is actually running.
            <div className="turn busy-turn" key={busy.label}>
              <Busy label={busy.step ? `${busy.label} · ${busy.step}` : busy.label} block />
            </div>
          )}

          {ambiguous && (
            <div className="turn choice">
              <div className="notice notice--warn" role="alert">
                <strong>That reads like a question, not an answer.</strong>
                <p>
                  Grading it records permanent evidence against{" "}
                  <b>{current?.name}</b> and cannot be undone.
                </p>
                <p className="quoted">{ambiguous}</p>
                <div className="row">
                  <button className="primary" onClick={() => void grade(ambiguous)}>
                    Grade this as my answer
                  </button>
                  <button onClick={() => void ask(ambiguous)}>
                    Just ask — the check stays open
                  </button>
                  <button
                    className="linkish"
                    onClick={() => { setInput(ambiguous); setAmbiguous(null); composer.current?.focus(); }}
                  >
                    edit it
                  </button>
                </div>
              </div>
            </div>
          )}

          {error && (
            // Its own turn role, not .turn.note: .turn.note .bubble beats .err on
            // specificity, so every failure on this page rendered as 11px grey mono,
            // indistinguishable from a routing diagnostic.
            <div className="turn failure">
              <div className="notice notice--error" role="alert">
                <strong>{error.title}</strong>
                <p>{error.message}</p>
                {error.remedy && <p className="remedy">{error.remedy}</p>}
                <div className="row">
                  {error.retry && (
                    <button onClick={() => { const r = error.retry!; setError(null); r(); }}>
                      {error.retryLabel ?? "Try again"}
                    </button>
                  )}
                  <button className="linkish" onClick={() => setError(null)}>dismiss</button>
                </div>
              </div>
            </div>
          )}

          {detour && !readOnly && (
            <div className="detour">
              <div>
                You seem to be missing <strong>{detour.name}</strong>. Cover it first?
              </div>
              <div className="row">
                <button
                  className="primary"
                  onClick={() => void teach(detour.conceptId, detour.name)}
                  aria-disabled={locked || undefined}
                >
                  Teach {detour.name}
                </button>
                <button onClick={() => setDetour(null)}>Stay here</button>
              </div>
            </div>
          )}
          <div ref={bottom} />
        </div>

        <div className="composer">
          <div className="composer-inner">
            {readOnly ? (
              <>
                <span className="muted composer-note">
                  Viewing a past session. Resume it to continue.
                </span>
                <button
                  className="primary"
                  onClick={() => void resume(viewingSession!)}
                  aria-disabled={locked || undefined}
                >
                  Resume this session
                </button>
                <button onClick={() => void load(learnerId).then(() => setViewingSession(null))}>
                  Back to current
                </button>
              </>
            ) : planComplete ? (
              <>
                <span className="muted composer-note">
                  This plan is complete. Pick a concept from the roadmap to revisit, or set
                  a new goal.
                </span>
                <button onClick={() => setShowIntake(true)}>Set a new goal</button>
              </>
            ) : (
              <>
                <label className="sr-only" htmlFor="composer-input">
                  {pending ? "Answer the check, or ask a question" : "Ask a question"}
                </label>
                <textarea
                  id="composer-input"
                  ref={composer}
                  rows={2}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    // Shift+Enter is a newline; an IME composition commit is not a send.
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={
                    pending
                      ? "Answer the check — or ask something instead"
                      : "Ask a question…"
                  }
                  aria-describedby={pending ? "check-hint" : undefined}
                  disabled={!current}
                />
                {/* One element, two actions: swapping two buttons here would unmount the
                    focused one mid-answer and drop focus to <body>. The label changes
                    because the action changed, not because a status did. */}
                <button
                  className="primary"
                  onClick={locked ? stop : send}
                  disabled={!current}
                  aria-disabled={(!locked && !input.trim()) || undefined}
                >
                  {locked ? "Stop" : "Send"}
                </button>
                <button
                  onClick={() => void teach()}
                  disabled={!current}
                  aria-disabled={locked || undefined}
                >
                  {turns.length === 0 ? "Start lesson" : "Re-explain"}
                </button>
                <button
                  onClick={() => void showMe(input.trim() || undefined)}
                  disabled={!current}
                  aria-disabled={locked || undefined}
                  title="Build an interactive example of this concept — or of whatever you have typed"
                >
                  Show me
                </button>
                {/* Enabled while busy on purpose: it is the way out of a slow answer. */}
                {turns.length > 0 && <button onClick={() => void reset()}>Start over</button>}
              </>
            )}
          </div>
          {pending && !readOnly && !planComplete && (
            <div className="composer-inner check-actions">
              <span className="eyebrow" id="check-hint">
                a check is open · answering it records evidence
              </span>
              <button
                onClick={() => void grade("I don't know")}
                aria-disabled={locked || undefined}
                title="Answered honestly. It costs this check and records that the concept is not established yet."
              >
                I don't know this
              </button>
              <button
                onClick={skipCheck}
                aria-disabled={locked || undefined}
                title="Leave it unanswered. Nothing is recorded, and it comes back."
              >
                Skip this check
              </button>
            </div>
          )}
        </div>
      </div>

      <aside className="inspector">
        {override && (
          <div className="notice notice--warn inspector-banner">
            On a detour to <strong>{override.name}</strong>.{" "}
            <button className="linkish" onClick={() => setOverride(null)}>back to the plan</button>
          </div>
        )}

        {phase === "loading" && (
          <section aria-hidden="true">
            <h4>Path</h4>
            <div className="skeleton skeleton--line skeleton--w80" />
            <div className="skeleton skeleton--line skeleton--w60" />
            <div className="skeleton skeleton--line skeleton--w80" />
            <div className="skeleton skeleton--line skeleton--w40" />
          </section>
        )}

        {phase === "failed" && (
          // No role="alert" here: the copy in the transcript already announces this
          // failure, and two alerts for one fault talk over each other.
          <div className="notice notice--error">
            <strong>The plan could not be loaded.</strong>
            This is not the same as having no plan. The retry is in the transcript.
          </div>
        )}

        {phase === "ready" && plan && (
          <>
            <section>
              <div className="head inspector-head">
                <h4>Goal</h4>
                {/* Read-only means read-only: from inside a historical transcript this
                    used to start a real lesson into the open session. */}
                {!readOnly && (
                  <button className="linkish" onClick={() => push({ role: "roadmap", text: "" })}>
                    show roadmap
                  </button>
                )}
              </div>
              <div className="rel">
                {plan.goal.topic}{" "}
                <span className="muted mono">
                  ({DEPTH_LABEL[plan.goal.depth]?.label ?? plan.goal.depth})
                </span>
              </div>
            </section>

            <section>
              <h4>Path</h4>
              {plan.steps.map((s: any) => {
                const isCurrent = s.conceptId === current?.conceptId;
                return (
                  <div
                    className={`rel step-row${isCurrent ? " step-row--now rail rail--accent" : ""}`}
                    key={s.conceptId}
                    data-done={s.completed || undefined}
                  >
                    <div className="row row--tight step-row-title">
                      <span
                        className="mastery-mark"
                        data-level={(s.currentMastery ?? "unknown") as Mastery}
                        title={MASTERY_MEANING[(s.currentMastery ?? "unknown") as Mastery]}
                      />
                      <strong>
                        {s.completed ? "✓ " : `${s.position + 1}. `}{s.name}
                      </strong>
                      {/* A chip, not a colour: the accent alone was the only encoding. */}
                      {isCurrent && <span className="pill pill--accent">now</span>}
                    </div>
                    <div className="fm">{s.currentMastery} → needs {s.requiredLevel}</div>
                  </div>
                );
              })}
            </section>

            {plan.milestones.length > 0 && (
              <section>
                <h4>Milestones</h4>
                {plan.milestones.map((m: any) => (
                  <div className="rel" key={m.id} data-done={m.completed || undefined}>
                    {m.completed ? "✓ " : ""}{m.claim}
                  </div>
                ))}
              </section>
            )}
          </>
        )}

        {phase === "ready" && !plan && (
          <p className="muted">No plan yet. Set a goal to get one.</p>
        )}

        {lessons.length > 0 && (
          <section>
            <h4>Lessons in this transcript ({lessons.length})</h4>
            <div className="stack stack--tight">
              {lessons.map((l) => (
                <button
                  className="linkish jump"
                  key={l.lid}
                  onClick={() =>
                    document.getElementById(`lesson-${l.lid}`)?.scrollIntoView({ block: "start" })
                  }
                >
                  {l.text.replace(/^Now teaching: /, "")}
                </button>
              ))}
            </div>
          </section>
        )}

        {sessions.length > 0 && (
          // Collapsed, and capped: an unbounded list of every session this learner has
          // ever had pushed the plan itself off the bottom of the sidebar.
          <details className="history">
            <summary>History ({sessions.length})</summary>
            <div className="head inspector-head">
              <span className="eyebrow">transcripts</span>
              <button
                className="linkish danger"
                onClick={() => {
                  if (confirm(`Delete all ${sessions.length} sessions? Transcripts go; what you learned stays.`)) {
                    void clearSessions();
                  }
                }}
                aria-disabled={locked || undefined}
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
                  <button
                    className="session-open"
                    onClick={() => void openSession(s.id)}
                    aria-disabled={locked || undefined}
                  >
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
                    aria-disabled={locked || undefined}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}

        {!readOnly && (
          <button className="new-goal" onClick={() => setShowIntake(true)}>
            New goal &amp; assessment
          </button>
        )}
      </aside>
    </div>
  );
}
