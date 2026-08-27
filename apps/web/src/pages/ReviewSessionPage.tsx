import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { api, HttpError } from "../api";
import type { Mastery } from "../api";
import { Busy } from "../components/Busy";
import { Markdown } from "../components/Markdown";
import { resolveLearner, useStickyLearner } from "../useLearner";
import { DUE_KIND, dueKindLabel, MASTERY_MEANING, MASTERY_RANK } from "../vocabulary";

/**
 * One pass over what has gone stale.
 *
 * Distinct from a lesson: nothing here is taught. Each item is a concept the learner
 * held once — or holds a recorded wrong belief about — and the only question is whether
 * it still stands up. A pass restores confidence and clears the belief; a failure records
 * that honestly and the concept comes back.
 *
 * Because it cannot teach, a failure has to lead somewhere: every failed verdict links out
 * to the graph. And because a pass is real work, it is resumable — a nav click used to
 * reset it to item 1 and zero the tally without saying so.
 */

/** Mirrors DEFAULT_THRESHOLDS.reprobeConfidenceFloor; @kg/shared is not a web dependency. */
const REPROBE_FLOOR = 0.4;

/** Re-serving a concept graded this recently asks the same question with nothing taught between. */
const RECHECK_COOLDOWN_MS = 5 * 60_000;

/** One question call plus one grading call, plus the time to write an answer. */
const MINUTES_PER_ITEM = 1.5;

/**
 * One key per learner. A single global key meant switching learner in the nav silently
 * discarded the other person's half-finished pass and their cooldown map, because the
 * `learnerId` guard below failed and `graded` reset to {}.
 */
const passKey = (learnerId: string) => `kg-tutor:review-pass:${learnerId}`;

/** A saved pass is the queue plus every generated question, so typing must not write one per key. */
const SAVE_DEBOUNCE_MS = 400;

type Failure = { message: string; remedy: string | null };

/**
 * A pass on disk.
 *
 * The learner id, the lesson transcript and the intake are all deliberately resumable and
 * this was not, so a refresh silently threw away a half-finished pass. `items` rather than
 * only the concept ids because a pass is a fixed list chosen at its start: an item that has
 * since left /due is still the item this pass is on, and "7 of 10" has to stay true.
 * `graded` outlives the pass — it is what stops "Check again" re-serving what was just
 * answered, which the queue's own ordering otherwise puts straight back on top.
 */
type Saved = {
  learnerId: string;
  at: number;
  items: any[];
  conceptIds: string[];
  sessionId: string | null;
  asked: Record<string, any>;
  drafts: Record<string, string>;
  verdicts: Record<string, any>;
  skips: Record<string, true>;
  graded: Record<string, number>;
  savedAt: number;
};

function readSaved(learnerId: string): Saved | null {
  // Throws outright in some contexts, not only when empty, so it cannot be left unguarded.
  try {
    const raw = localStorage.getItem(passKey(learnerId));
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function writeSaved(saved: Saved): void {
  try {
    localStorage.setItem(passKey(saved.learnerId), JSON.stringify(saved));
  } catch {
    /* resuming is a convenience; failing to remember must not break the pass */
  }
}

/** Cooldown entries past their window would otherwise accumulate forever. */
function prune(graded: Record<string, number>, now: number): Record<string, number> {
  const live: Record<string, number> = {};
  for (const [id, at] of Object.entries(graded)) {
    if (now - at < RECHECK_COOLDOWN_MS) live[id] = at;
  }
  return live;
}

function asFailure(e: unknown): Failure {
  return {
    message: e instanceof Error ? e.message : String(e),
    remedy: e instanceof HttpError ? e.remedy : null,
  };
}

/** The server writes reasons as fragments; the card reads them as prose. */
function sentence(text: string): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  const head = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(head) ? head : `${head}.`;
}

function confidencePhrase(kind: string, confidence: number): string {
  const value = confidence.toFixed(2);
  // Only a decayed item is due *because* of the floor, so only it is measured against it.
  return kind === "decayed"
    ? `Confidence ${value}, below the ${REPROBE_FLOOR.toFixed(2)} re-probe floor.`
    : `Confidence ${value}.`;
}

const PAGE = "page page--measure review-session";

export function ReviewSessionPage() {
  const [learnerId, setLearnerId] = useStickyLearner();
  // null means "not asked yet", which is not the same claim as "there are none".
  const [learners, setLearners] = useState<any[] | null>(null);

  const [queue, setQueue] = useState<any[]>([]);
  const [deferred, setDeferred] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [fatal, setFatal] = useState<Failure | null>(null);

  const [at, setAt] = useState(0);
  const [asked, setAsked] = useState<Record<string, any>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [verdicts, setVerdicts] = useState<Record<string, any>>({});
  const [skips, setSkips] = useState<Record<string, true>>({});
  const [graded, setGraded] = useState<Record<string, number>>({});
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pending, setPending] = useState<Saved | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Failure | null>(null);

  const answerRef = useRef<HTMLTextAreaElement | null>(null);
  const verdictRef = useRef<HTMLDivElement | null>(null);

  /**
   * Who exists. Retried as well as loaded on mount: this is the call that fails first, and
   * a Retry that only re-fetched /due left `learners` at [] with a full queue in state —
   * the page then printed "No learners yet" over a loaded pass.
   *
   * Returns the resolved id so the retry knows whether the learner effect will fire.
   */
  const loadLearners = useCallback(async (want: string): Promise<string> => {
    // null is "not asked yet" again, so the retry has a visible in-progress state; without
    // this, a first-time learner (nothing stored, learners fetch failed) clicked Retry and
    // nothing on the page changed at all.
    setLearners(null);
    setFatal(null);
    try {
      const l = await api.learners();
      setLearners(l);
      const id = resolveLearner(want, l);
      setLearnerId(id);
      return id;
    } catch (e) {
      setLearners([]);
      setFatal(asFailure(e));
      return "";
    }
  }, [setLearnerId]);

  useEffect(() => {
    void loadLearners(learnerId);
  }, []);

  /** `cooldown` is a parameter rather than state: a retry has to use the current map. */
  const loadQueue = useCallback(async (id: string, cooldown: Record<string, number>) => {
    if (!id) return;
    // Without this a retry keeps rendering the failure it is retrying.
    setFatal(null);
    setLoaded(false);
    setBusy("checking what has decayed");
    try {
      const d = await api.due(id);
      const cutoff = Date.now() - RECHECK_COOLDOWN_MS;
      const fresh: any[] = [];
      const held: any[] = [];
      for (const item of (d.items ?? []) as any[]) {
        ((cooldown[item.conceptId] ?? 0) < cutoff ? fresh : held).push(item);
      }
      setQueue(fresh);
      setDeferred(held);
      setTotal(d.total ?? fresh.length + held.length);
      setAt(0);
      setAsked({}); setDrafts({}); setVerdicts({}); setSkips({});
      setSessionId(null);
      setError(null);
      setLoaded(true);
    } catch (e) {
      setFatal(asFailure(e));
    } finally {
      setBusy(null);
    }
  }, []);

  /**
   * Both calls, in order, because either can be the one that failed.
   *
   * The learner effect below reloads the queue whenever the id changes, so asking again
   * here would double-fetch; when the id resolves to the same learner nothing fires and
   * this is the only thing that reloads it.
   */
  const retry = useCallback(async () => {
    const id = await loadLearners(learnerId);
    if (id && id === learnerId) await loadQueue(id, graded);
  }, [loadLearners, loadQueue, learnerId, graded]);

  useEffect(() => {
    if (!learnerId) return;
    const saved = readSaved(learnerId);
    const mine = saved && saved.learnerId === learnerId ? saved : null;
    const cooldown = prune(mine?.graded ?? {}, Date.now());
    setGraded(cooldown);
    setPending(mine && mine.items.length > 0 && mine.at < mine.items.length ? mine : null);
    void loadQueue(learnerId, cooldown);
  }, [learnerId, loadQueue]);

  const current = queue[at] ?? null;
  const conceptId: string | null = current?.conceptId ?? null;
  const question = conceptId ? asked[conceptId] ?? null : null;
  const answer = conceptId ? drafts[conceptId] ?? "" : "";
  const result = conceptId ? verdicts[conceptId] ?? null : null;

  // While a decision on a saved pass is outstanding, writing would destroy the thing
  // being offered. `drafts` changes on every keystroke, so the write itself is on a
  // trailing edge — and the pending payload is held so navigating away inside that
  // window still saves it rather than dropping the last thing typed.
  const unsaved = useRef<Saved | null>(null);
  useEffect(() => {
    if (!learnerId || pending || !loaded) {
      // A new load resets the pass, so anything still queued describes a pass that no
      // longer exists and must not be flushed on the way out.
      unsaved.current = null;
      return;
    }
    const payload: Saved = {
      learnerId,
      at,
      items: queue,
      conceptIds: queue.map((it) => it.conceptId),
      sessionId,
      asked, drafts, verdicts, skips,
      graded: prune(graded, Date.now()),
      savedAt: Date.now(),
    };
    unsaved.current = payload;
    const t = setTimeout(() => {
      writeSaved(payload);
      unsaved.current = null;
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [learnerId, pending, loaded, at, queue, sessionId, asked, drafts, verdicts, skips, graded]);

  useEffect(() => () => {
    if (unsaved.current) writeSaved(unsaved.current);
  }, []);

  const tally = useMemo(() => {
    let passed = 0, failed = 0, skipped = 0;
    const failures: any[] = [];
    for (const item of queue) {
      const v = verdicts[item.conceptId];
      if (v) {
        if (v.grade.correct) passed++;
        else { failed++; failures.push(item); }
      } else if (skips[item.conceptId]) skipped++;
    }
    return { passed, failed, skipped, failures };
  }, [queue, verdicts, skips]);

  const ask = async () => {
    if (busy || !current) return;
    setBusy("writing a question");
    setError(null);
    try {
      // The level it was held at, not the next one up: this is a re-check, not a promotion.
      const level = current.mastery === "unknown" ? "familiar" : current.mastery;
      // "review", so this pass gets its own session rather than writing into the lesson.
      const q = await api.check(learnerId, current.conceptId, level, "review");
      // The session the question turn was written into. The answer has to land in the same
      // one, or the transcript holds a question that is never replied to.
      if (q?.sessionId) setSessionId(q.sessionId);
      setAsked((m) => ({ ...m, [current.conceptId]: q }));
    } catch (e) {
      setError(asFailure(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (busy || !current || !question || !answer.trim()) return;
    setBusy("checking your answer");
    setError(null);
    try {
      const r = await api.attempt(learnerId, {
        kind: "review",
        conceptId: current.conceptId,
        prompt: question.prompt,
        response: answer,
        requiresTransfer: question.requiresTransfer,
        itemId: question.itemId,
        // Omitting this adopted whatever lesson session was still open, so review Q&A
        // landed in the Learn transcript and cleared that lesson's pending check.
        sessionId: question.sessionId ?? sessionId ?? undefined,
      });
      if (r?.sessionId) setSessionId(r.sessionId);
      setVerdicts((m) => ({ ...m, [current.conceptId]: r }));
      setGraded((m) => ({ ...m, [current.conceptId]: Date.now() }));
    } catch (e) {
      setError(asFailure(e));
    } finally {
      setBusy(null);
    }
  };

  const skip = () => {
    if (busy || !current) return;
    // Counted and reversible, so the tally adds up and Back undoes it.
    setSkips((m) => ({ ...m, [current.conceptId]: true }));
    setError(null);
    setAt((i) => i + 1);
  };
  const next = () => { setError(null); setAt((i) => i + 1); };
  const back = () => { setError(null); setAt((i) => Math.max(0, i - 1)); };

  const setDraft = (text: string) => {
    if (!conceptId) return;
    setDrafts((m) => ({ ...m, [conceptId]: text }));
  };

  const onAnswerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  const resume = () => {
    const saved = pending;
    if (!saved) return;
    // Fresher state where the server still has it, but the pass keeps the list — and so
    // the count — it started with.
    const fresh = new Map(queue.map((it) => [it.conceptId, it]));
    setQueue(saved.items.map((it) => fresh.get(it.conceptId) ?? it));
    setAt(Math.min(saved.at, Math.max(0, saved.items.length - 1)));
    // `total` deliberately stays the number this load measured: the backlog moves on
    // whether or not the pass does.
    setAsked(saved.asked ?? {});
    setDrafts(saved.drafts ?? {});
    setVerdicts(saved.verdicts ?? {});
    setSkips(saved.skips ?? {});
    setSessionId(saved.sessionId ?? null);
    setPending(null);
  };

  // Both async transitions unmount the control that started them, and a control that
  // unmounts takes the focus ring with it, so whatever replaces it has to claim focus.
  useEffect(() => {
    if (question && !result) answerRef.current?.focus();
  }, [question, result, at]);
  useEffect(() => {
    if (result) verdictRef.current?.focus();
  }, [result, at]);

  // Grows with the answer rather than making the learner drag a corner for room. The
  // border has to be added back: box-sizing is border-box and scrollHeight excludes it.
  useEffect(() => {
    const el = answerRef.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + border}px`;
  }, [answer, question, at]);

  const learnPath = (id: string) =>
    `/graph?node=${encodeURIComponent(id)}&learner=${encodeURIComponent(learnerId)}`;

  const failureNotice = (f: Failure, title: string) => (
    <div className="notice notice--error" role="alert">
      <strong>{title}</strong>
      <p>{f.message}</p>
      {f.remedy && <p className="rs-remedy">{f.remedy}</p>}
    </div>
  );

  // ── Asked, and it failed. Not the same claim as "nothing is due". ──────────────
  if (fatal) {
    return (
      <div className={PAGE}>
        <h2>Review</h2>
        {failureNotice(fatal, "Could not find out what is due.")}
        <div className="row rs-actions">
          <button className="primary" onClick={() => void retry()}>Retry</button>
          <Link className="btn" to="/">Home</Link>
        </div>
      </div>
    );
  }

  // ── Not asked yet ─────────────────────────────────────────────────────────────
  if (learners === null || (learners.length > 0 && !loaded)) {
    return (
      <div className={PAGE}>
        <h2>Review</h2>
        <Busy label="checking what has decayed" block />
        <div className="panel rs-card" aria-hidden="true">
          <div className="skeleton skeleton--line skeleton--w60" />
          <div className="skeleton skeleton--line skeleton--w80" />
          <div className="skeleton skeleton--line skeleton--w40" />
        </div>
      </div>
    );
  }

  // A loaded queue is proof the learner exists — it came from that learner's own /due —
  // so an empty list only means the roster call is the one that failed. Never claim
  // "no learners" over a pass that is sitting in state.
  if (learners.length === 0 && queue.length === 0) {
    return (
      <div className={PAGE}>
        <h2>No learners yet</h2>
        <p className="muted">
          A review pass checks what one person held once, so there is nothing to check
          until a learner exists.
        </p>
        <Link className="btn primary" to="/">Home</Link>
      </div>
    );
  }

  // ── A pass was interrupted ────────────────────────────────────────────────────
  if (pending) {
    return (
      <div className={PAGE}>
        <h2>Review</h2>
        <div className="notice notice--info">
          <strong>You were {pending.at + 1} of {pending.items.length} through a pass.</strong>
          <p>
            Picking it up keeps the tally and the items that were left. Starting again asks
            for a fresh queue — everything already answered is recorded either way.
          </p>
        </div>
        <div className="row rs-actions">
          <button className="primary" onClick={resume}>Resume that pass</button>
          <button onClick={() => setPending(null)}>Start a new pass</button>
        </div>
      </div>
    );
  }

  // ── Every item in the pass has been seen ──────────────────────────────────────
  if (queue.length > 0 && at >= queue.length) {
    const remaining = Math.max(0, total - queue.length);
    return (
      <div className={PAGE}>
        <h2>Pass finished</h2>
        <div
          className="progress"
          role="progressbar"
          aria-label="progress through this pass"
          aria-valuemin={0}
          aria-valuemax={queue.length}
          aria-valuenow={queue.length}
          aria-valuetext={
            `all ${queue.length} seen` +
            (tally.skipped > 0 ? `, ${tally.skipped} skipped rather than checked` : "")
          }
        >
          <div className="bar rs-bar-full" />
        </div>
        <p>
          {tally.passed} held up, {tally.failed} did not
          {tally.skipped > 0 ? `, ${tally.skipped} skipped` : ""}. Anything that failed is
          back in the queue with its confidence recorded honestly rather than assumed.
        </p>

        {tally.failures.length > 0 && (
          <section className="panel panel--inset stack rs-failures">
            <p className="eyebrow">what did not hold</p>
            <p className="rs-note">
              Nothing on this page teaches these. The graph has the explanation, and the
              prerequisites underneath it.
            </p>
            <ul className="rs-list">
              {tally.failures.map((it) => (
                <li key={it.conceptId}>
                  <Link to={learnPath(it.conceptId)}>{it.conceptName}</Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {tally.skipped > 0 && (
          <p className="rs-note">
            Skipped items were not answered either way, so they are still due.
          </p>
        )}

        <div className="row rs-actions">
          {/* Not "Next 25": the cooldown filter runs after the next /due, so a pass whose
              failures sort straight back to the top can serve none of them and land on
              "Just checked" instead. The backlog size is stated below, where it is true. */}
          {remaining > 0 ? (
            <button className="primary" onClick={() => void loadQueue(learnerId, graded)}>
              Next batch
            </button>
          ) : (
            <button onClick={() => void loadQueue(learnerId, graded)}>Check again</button>
          )}
          <Link className="btn" to="/">Home</Link>
        </div>

        {remaining > 0 && (
          <p className="rs-note">
            {remaining} more {remaining === 1 ? "concept is" : "concepts are"} still due.
          </p>
        )}
      </div>
    );
  }

  // ── Asked, and there is nothing to serve ──────────────────────────────────────
  if (queue.length === 0) {
    if (deferred.length > 0) {
      return (
        <div className={PAGE}>
          <h2>Just checked</h2>
          <div className="notice notice--info">
            <strong>
              {deferred.length} still due, but {deferred.length === 1 ? "it was" : "they were"}{" "}
              checked in the last few minutes.
            </strong>
            <p>
              Asking again now would re-serve the same question with nothing taught in
              between. Read up on them, or come back later.
            </p>
          </div>
          <ul className="rs-list">
            {deferred.map((it) => (
              <li key={it.conceptId}>
                <Link to={learnPath(it.conceptId)}>{it.conceptName}</Link>
              </li>
            ))}
          </ul>
          <Link className="btn" to="/">Home</Link>
        </div>
      );
    }
    return (
      <div className={PAGE}>
        <h2>Nothing due</h2>
        <p className="muted">
          Nothing has decayed past the re-probe floor and no wrong beliefs are on record.
        </p>
        <Link className="btn" to="/">Home</Link>
      </div>
    );
  }

  const mastery = current.mastery as Mastery;
  const answered = at + (result ? 1 : 0);
  const minutesLeft = Math.max(1, Math.round((queue.length - answered) * MINUTES_PER_ITEM));
  const questionId = `rs-question-${at}`;
  const transferId = `rs-transfer-${at}`;
  const before = result ? (result.state.before.mastery as Mastery) : mastery;
  const after = result ? (result.state.after.mastery as Mastery) : mastery;
  const demoted = MASTERY_RANK[after] < MASTERY_RANK[before];

  return (
    <div className={PAGE}>
      <div className="head">
        <div className="stack stack--tight">
          <h2>Review</h2>
          <p className="rs-count">
            item {at + 1} of {queue.length}
            {total > queue.length ? ` · ${total} due in total` : ""}
            {" · nothing here is taught, only checked"}
          </p>
          <p className="rs-note">about {minutesLeft} min left in this pass</p>
        </div>
      </div>

      {/* "N checked" was a lie for a pass with skips: a skip advances the bar without an
          answer, and the done screen's own tally distinguishes the two. */}
      <div
        className="progress"
        role="progressbar"
        aria-label="progress through this pass"
        aria-valuemin={0}
        aria-valuemax={queue.length}
        aria-valuenow={answered}
        aria-valuetext={
          `${answered} of ${queue.length} seen` +
          (tally.skipped > 0 ? `, ${tally.skipped} skipped rather than checked` : "")
        }
      >
        <div className="bar" style={{ width: `${(answered / queue.length) * 100}%` }} />
      </div>

      <article className="panel stack rs-card">
        <div className="stack stack--tight">
          <h3 className="rs-name">{current.conceptName}</h3>
          <p className="rs-why">{sentence(current.reason)}</p>
          <p className="rs-rank">
            <b>{sentence(dueKindLabel(current.kind, 1))}</b> {DUE_KIND[current.kind]?.rank}
          </p>
          <p className="rs-state">
            <span className="mastery-mark" data-level={mastery} aria-hidden="true" />
            {mastery === "unknown"
              ? "Nothing recorded at any level yet."
              : `Held at ${mastery} — ${MASTERY_MEANING[mastery]}.`}{" "}
            {confidencePhrase(current.kind, current.confidence)}
          </p>
        </div>

        {/* The belief is deliberately not shown before the question: being shown it is
            enough to avoid it for one answer, and a pass clears the record for good. */}
        {!question && !result && (
          <div className="row rs-actions">
            <button className="primary" aria-disabled={busy !== null} onClick={() => void ask()}>
              Check this one
            </button>
            <button aria-disabled={busy !== null} onClick={skip}>Skip this one</button>
            {at > 0 && <button onClick={back}>Back</button>}
            {busy && <Busy label={busy} />}
          </div>
        )}

        {question && !result && (
          <div className="stack">
            <div className="coach-q rs-q rail" id={questionId}>
              <Markdown text={question.prompt} />
              {question.code && (
                <Markdown text={`\`\`\`${question.codeLanguage ?? ""}\n${question.code}\n\`\`\``} />
              )}
            </div>
            {question.requiresTransfer && (
              <p className="rs-transfer" id={transferId}>
                Deliberately an unfamiliar setting — recalling the explanation will not be
                enough here.
              </p>
            )}
            <label className="rs-answer">
              <span className="eyebrow">your answer</span>
              <textarea
                ref={(el) => { answerRef.current = el; }}
                rows={4}
                value={answer}
                placeholder="In your own words."
                aria-describedby={
                  question.requiresTransfer ? `${questionId} ${transferId}` : questionId
                }
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onAnswerKeyDown}
              />
            </label>
            <div className="row rs-actions">
              <button
                className="primary"
                aria-disabled={busy !== null || !answer.trim()}
                onClick={() => void submit()}
              >
                Answer
              </button>
              <button aria-disabled={busy !== null} onClick={skip}>Skip this one</button>
              {at > 0 && <button onClick={back}>Back</button>}
              {busy && <Busy label={busy} />}
            </div>
            <p className="rs-note rs-hint">Ctrl or ⌘ with Enter answers.</p>
          </div>
        )}

        {result && (
          <div
            className={`verdict ${result.grade.correct ? "ok" : "gap"} rs-verdict`}
            ref={verdictRef}
            tabIndex={-1}
            role="group"
            aria-label={result.grade.correct ? "Still holds" : "Not any more"}
          >
            <strong>{result.grade.correct ? "Still holds." : "Not any more."}</strong>{" "}
            <span className="verdict-why"><Markdown text={result.grade.reasoning} /></span>

            {current.belief && (
              <div className="notice notice--warn rs-belief">
                <strong>What you appeared to believe</strong>
                <p>{current.belief}</p>
                <p className="rs-belief-state">
                  {result.grade.correct
                    ? "Cleared — you answered without being shown it."
                    : "Still on record."}
                </p>
              </div>
            )}

            {demoted && (
              <p className="rs-demoted rail rail--danger">
                <span aria-hidden="true">↓ </span>
                Dropped from {before} to <b>{after}</b>.
              </p>
            )}

            <div className="chips">
              {!demoted && (
                <span className="chip">
                  {before === after ? (
                    <>held at {after}</>
                  ) : (
                    <>
                      {before} <span aria-hidden="true">→</span>
                      <span className="sr-only">to</span> <b>{after}</b>
                    </>
                  )}
                </span>
              )}
              <span className="chip">
                confidence {result.state.after.confidence.toFixed(2)}
              </span>
              {result.misconceptionsResolved > 0 && (
                <span className="chip">
                  cleared {result.misconceptionsResolved} recorded belief
                  {result.misconceptionsResolved === 1 ? "" : "s"}
                </span>
              )}
            </div>

            <div className="row rs-actions">
              <button className="primary" onClick={next}>
                {at + 1 < queue.length ? "Next" : "Finish"}
              </button>
              {!result.grade.correct && (
                <Link className="btn" to={learnPath(current.conceptId)}>Learn this</Link>
              )}
              {at > 0 && <button onClick={back}>Back</button>}
            </div>
          </div>
        )}

        {error && failureNotice(error, "That did not go through.")}
      </article>
    </div>
  );
}
