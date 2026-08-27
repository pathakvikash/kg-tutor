import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { resolveLearner, useStickyLearner } from "../useLearner";
import { api, HttpError } from "../api";
import { Busy } from "../components/Busy";
import { Roadmap } from "../components/Roadmap";
import { DEPTH_LABEL, MASTERY_MEANING, MASTERY_ORDER } from "../vocabulary";

/** A read that failed, in the two flavours a page has to tell apart. */
type Failure = { message: string; remedy: string | null; missing: boolean };

function asFailure(e: unknown): Failure {
  if (e instanceof HttpError) return { message: e.message, remedy: e.remedy, missing: e.isMissing };
  return { message: e instanceof Error ? e.message : String(e), remedy: null, missing: false };
}

type Read<T> = { ok: true; value: T } | { ok: false; failure: Failure };

/** Settles instead of rejecting, so one failed read cannot hide the other section. */
function read<T>(p: Promise<T>): Promise<Read<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (e: unknown) => ({ ok: false as const, failure: asFailure(e) }),
  );
}

function ReadFailure({ title, failure, onRetry }: {
  title: string;
  failure: Failure;
  onRetry: () => void;
}) {
  return (
    <div className="notice notice--error learner-note" role="alert">
      <strong>{title}</strong>
      <p>{failure.message}</p>
      {failure.remedy && <p>{failure.remedy}</p>}
      <button onClick={onRetry}>Retry</button>
    </div>
  );
}

/** "We have not asked yet", which is not the same claim as "there is nothing here". */
function Lines({ count = 3 }: { count?: number }) {
  const widths = ["skeleton--w80", "skeleton--w60", "skeleton--w40"];
  // aria-busy so the section admits it is mid-read. The spoken half is one page-level
  // live region (see the page body): every section here loads off the same two reads, so
  // five separate "loading" announcements would be noise rather than information.
  return (
    <div aria-busy="true">
      <div aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div className={`skeleton skeleton--line ${widths[i % widths.length]}`} key={i} />
        ))}
      </div>
    </div>
  );
}

/** "14 Mar" — a date a learner can act on, from a timestamp they cannot read. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * Expanding a new topic. This was the missing loop: the endpoint existed but nothing in
 * the UI reached it, so the graph could only grow from a seed or a curl. A learner
 * typing "React" is the whole premise of the product.
 *
 * Everything here is gated because the write is shared and irreversible: the concepts and
 * edges it creates land in the one graph every learner sees, and nothing in the app takes
 * them back out.
 */
function NewTopic({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [job, setJob] = useState<any>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  /** Set after several failed polls in a row, so a dead job stops reading as "queued · 0%". */
  const [lost, setLost] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const buildRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);

  // A live region that announces its own buttons and never takes focus leaves a keyboard
  // user hunting for what just spoke. Focus the dialog itself rather than "Yes, build it":
  // a held Enter on the button that opened it must not fall through onto the confirm.
  useEffect(() => { if (confirming) confirmRef.current?.focus(); }, [confirming]);

  // A build outlives this page, so the form must not offer to start one that is already
  // running — leaving and coming back showed an empty field mid-build.
  useEffect(() => {
    let cancelled = false;
    void api.expansions()
      .then((all) => {
        if (cancelled) return;
        const live = all.find((j: any) => j.status === "queued" || j.status === "running");
        if (live) setJob(live);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!job || job.status === "done" || job.status === "failed" || lost) return;
    // A successful poll calls setJob, which re-runs this effect and resets the counter; a
    // failed one does not, so only consecutive misses accumulate.
    let misses = 0;
    const timer = setInterval(() => {
      void api.expansion(job.id)
        .then((j) => {
          misses = 0;
          setJob(j);
          if (j.status === "done") onDone();
        })
        .catch(() => { if (++misses >= 3) setLost(true); });
    }, 2000);
    return () => clearInterval(timer);
  }, [job, onDone, lost]);

  const running = !lost && job && (job.status === "queued" || job.status === "running");
  const pct = Math.round((job?.progress ?? 0) * 100);
  const report = job?.report ?? {};

  const start = async () => {
    setConfirming(false); setError(null); setLost(false); setStarting(true);
    try { setJob(await api.startExpansion(name.trim())); }
    catch (e) { setError(asFailure(e)); }
    finally { setStarting(false); }
  };

  const retry = async () => {
    setError(null); setLost(false);
    try { setJob(await api.retryExpansion(job.id)); }
    catch (e) { setError(asFailure(e)); }
  };

  return (
    <section className="panel stack learner-build" aria-labelledby="build-h">
      <h3 className="eyebrow" id="build-h">Learn something new</h3>

      <label className="learner-label" htmlFor="new-topic">Topic to build into the graph</label>
      <p className="muted learner-hint" id="new-topic-hint">
        Anything the graph does not have yet. It asks the model the same question three
        times and keeps only what a majority names — once for the topic, then again for the
        prerequisites of every concept it found — so a twenty-concept topic is sixty-odd
        model calls over several minutes. What it writes goes into the graph every learner
        shares, and this page cannot take it back out.
      </p>

      <div className="row">
        <input
          id="new-topic"
          ref={inputRef}
          className="learner-topic"
          aria-describedby="new-topic-hint"
          value={name}
          onChange={(e) => setName(e.target.value)}
          // Enter moves to the button instead of committing: this spends minutes of model
          // time on a shared write, so a typo must not be able to reach it.
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); buildRef.current?.focus(); } }}
          placeholder="e.g. React, SQL, recursion"
        />
        <button
          ref={buildRef}
          className="primary"
          aria-disabled={!name.trim() || !!running || starting}
          onClick={() => {
            if (!name.trim()) { inputRef.current?.focus(); return; }
            if (running || starting) return;
            setConfirming(true);
          }}
        >
          Build the graph
        </button>
        {starting && <Busy label="starting the build" clock={false} />}
      </div>

      {confirming && (
        <div
          className="notice notice--warn learner-confirm"
          role="alertdialog"
          aria-labelledby="build-confirm-h"
          ref={confirmRef}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setConfirming(false); buildRef.current?.focus(); }
          }}
        >
          <strong id="build-confirm-h">Build “{name.trim()}” into the shared graph?</strong>
          <p>
            Sixty-odd model calls and several minutes for a topic this size. New concepts,
            edges and milestones are written for everyone, and there is no undo.
          </p>
          <div className="row">
            <button className="primary" onClick={() => void start()}>Yes, build it</button>
            <button onClick={() => { setConfirming(false); buildRef.current?.focus(); }}>
              Not now
            </button>
          </div>
        </div>
      )}

      {running && (
        <div className="stack stack--tight">
          <div
            className="progress"
            role="progressbar"
            aria-label={`Building ${job.topicName}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-valuetext={`${pct}% — ${job.phase ?? "queued"}`}
          >
            <div className="bar" style={{ width: `${pct}%` }} />
          </div>
          <Busy label={`${job.phase ?? "queued"} · ${pct}%`} clock={false} />
        </div>
      )}

      {lost && job && (
        <div className="notice notice--error" role="alert">
          <strong>Lost contact with this build</strong>
          <p>
            Three status checks in a row failed, so this page cannot say whether “
            {job.topicName}” is still running. The job itself is unaffected by that — if
            the server is alive, it is still working.
          </p>
          <button onClick={() => setLost(false)}>Check again</button>
        </div>
      )}

      {job?.status === "done" && (
        <div className="stack stack--tight">
          <div className="notice notice--ok" role="status">
            <strong>Built {job.topicName}</strong>
            <p>Pick it as a topic below to plan against it.</p>
          </div>
          <div className="build-stats">
            <span><b>{report.conceptsCreated ?? 0}</b> new</span>
            <span><b>{report.conceptsBound ?? 0}</b> reused</span>
            <span><b>{report.edgesWritten ?? 0}</b> edges</span>
            {report.edgesDemoted > 0 && <span><b>{report.edgesDemoted}</b> demoted to soft</span>}
            {report.milestones?.length > 0 && (
              <span><b>{report.milestones.length}</b> milestones</span>
            )}
          </div>
          {report.conceptsDroppedByConsensus?.length > 0 && (
            <p className="muted learner-hint">
              Dropped for want of a majority: {report.conceptsDroppedByConsensus.join(", ")}.
            </p>
          )}
        </div>
      )}

      {job?.status === "failed" && (
        <div className="notice notice--error" role="alert">
          <strong>That build failed</strong>
          <p>{job.error}</p>
          <button onClick={() => void retry()}>Try again</button>
        </div>
      )}

      {error && (
        <div className="notice notice--error" role="alert">
          <strong>Could not start the build</strong>
          <p>{error.message}</p>
          {error.remedy && <p>{error.remedy}</p>}
        </div>
      )}
    </section>
  );
}

/** The page draws the mastery scale in three places and had no key for it anywhere. */
function MasteryLegend() {
  return (
    <ul className="legend learner-legend">
      {MASTERY_ORDER.map((m) => (
        <li key={m}>
          <span className="mastery-mark" data-level={m} aria-hidden="true" />
          <b>{m}</b> — {MASTERY_MEANING[m]}
        </li>
      ))}
    </ul>
  );
}

/**
 * The learner model, read first and edited second.
 *
 * The page is opened to answer "what does the tutor think I know", so nothing here may
 * destroy that answer as a side effect of arriving. The two selects describe the active
 * goal rather than a default, and replacing a plan is a named, confirmed act.
 */
export function LearnerPage() {
  const [learners, setLearners] = useState<any[]>([]);
  const [topics, setTopics] = useState<any[]>([]);
  const [id, setId] = useStickyLearner();
  const [state, setState] = useState<any>(null);
  const [stateFail, setStateFail] = useState<Failure | null>(null);
  const [plan, setPlan] = useState<any>(null);
  const [planFail, setPlanFail] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(true);
  const [depth, setDepth] = useState("use");
  const [topicId, setTopicId] = useState("");
  const [busy, setBusy] = useState<"goal" | "replan" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** Which load is current. A slow first response must not land under a second learner. */
  const generation = useRef(0);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    void api.learners().then((l) => { setLearners(l); setId(resolveLearner(id, l)); });
    void api.topics().then(setTopics);
  }, []);

  const load = useCallback(async (learnerId: string) => {
    if (!learnerId) { setLoading(false); return; }
    const mine = ++generation.current;
    setLoading(true);
    // Independent reads: the plan 404s for a learner who has no goal yet, which says
    // nothing about whether their concept record loaded.
    const [s, p] = await Promise.all([
      read(api.learnerState(learnerId)),
      read(api.plan(learnerId)),
    ]);
    if (mine !== generation.current) return;
    setState(s.ok ? s.value : null);
    setStateFail(s.ok ? null : s.failure);
    setPlan(p.ok ? p.value : null);
    setPlanFail(p.ok ? null : p.failure);
    setLoading(false);
  }, []);

  useEffect(() => { void load(id); }, [id, load]);

  const activeGoal = state?.goals?.find((g: any) => g.active) ?? null;
  /**
   * A failed learner read is not "this learner has no goal", but activeGoal is derived
   * from state and cannot tell the two apart: on a 500 the panel claimed "No goal yet",
   * the primary button relabelled itself "Set goal & plan", and its unconfirmed branch
   * retired the learner's real goal on one click — with the real plan still drawn under
   * Path from the read that succeeded. No goal write is offered while the goal is unknown.
   */
  const goalUnknown = stateFail !== null;

  // The selects describe the goal that exists. They were pinned to topics[0] and "use", so
  // the primary button acted on values the learner had never chosen and never saw. Keyed
  // on the learner too, or a learner with no goal inherits the last one's draft.
  useEffect(() => {
    if (loading) return;
    if (activeGoal) { setTopicId(activeGoal.topicId); setDepth(activeGoal.depth); }
    else { setTopicId(""); setDepth("use"); }
  }, [id, loading, activeGoal?.id, activeGoal?.topicId, activeGoal?.depth]);

  useEffect(() => {
    if (!activeGoal && !topicId && topics[0]) setTopicId(topics[0].id);
  }, [activeGoal, topicId, topics]);

  // A result belongs to the inputs that produced it. Changing any of them makes the
  // banner underneath a claim about something else.
  useEffect(() => { setNote(null); setFailure(null); setConfirming(false); }, [id, topicId, depth]);

  // Both are only ever set by one of the two plan actions, and both actions destroy the
  // control that was focused, so focus follows the outcome instead of falling to <body>.
  useEffect(() => { if (note || failure) resultRef.current?.focus(); }, [note, failure]);

  // The confirm is a dialog, so focus moves into it — announced-but-unfocused was the
  // wrong half of the pattern. The container takes focus rather than "Replace it".
  useEffect(() => { if (confirming) confirmRef.current?.focus(); }, [confirming]);

  const dirty = !activeGoal || topicId !== activeGoal.topicId || depth !== activeGoal.depth;
  const committed = plan?.steps?.filter((s: any) => s.committed).length ?? 0;
  const targetTopic = topics.find((t) => t.id === topicId)?.name ?? "the selected topic";
  const depthLabel = (d: string) => DEPTH_LABEL[d]?.label ?? d;

  const applyGoal = async () => {
    setBusy("goal"); setNote(null); setFailure(null); setConfirming(false);
    try {
      const r = await api.setGoal(id, topicId, depth);
      setNote(
        `Plan v${r.plan.version} for ${targetTopic}: ${r.plan.steps.length} concepts, ` +
        `${r.plan.milestones.length} milestones.`,
      );
      await load(id);
    } catch (e) {
      setFailure(asFailure(e));
    } finally { setBusy(null); }
  };

  const rebuild = async () => {
    setBusy("replan"); setNote(null); setFailure(null);
    try {
      const r = await api.rebuildPlan(id);
      // Growth is stated plainly rather than silently moving progress backwards. (08)
      setNote(`Plan v${r.version} — ${r.revisionReason ?? "no change"}`);
      await load(id);
    } catch (e) {
      setFailure(asFailure(e));
    } finally { setBusy(null); }
  };

  const refreshTopics = useCallback(() => { void api.topics().then(setTopics); }, []);
  const openConcept = (conceptId: string) =>
    navigate(`/graph?node=${encodeURIComponent(conceptId)}&learner=${encodeURIComponent(id)}`);

  const states: any[] = state?.states ?? [];
  const misconceptions: any[] = state?.misconceptions ?? [];

  return (
    <div className="page page--table learner-page">
      <div className="head">
        <div className="stack stack--tight">
          <h2>Learner model</h2>
          <p className="muted">
            What the tutor believes about this learner, and the plan it derives from it.
          </p>
        </div>
        <label className="field">
          learner
          <select value={id} onChange={(e) => setId(e.target.value)}>
            {learners.map((l) => <option key={l.id} value={l.id}>{l.email}</option>)}
          </select>
        </label>
      </div>

      {/* One live region for the whole page: the five sections below are drawn from the
          same two reads and finish together, so per-section announcements would talk over
          each other. Mounted unconditionally, because a region that appears already
          holding its text is not a change and may never be spoken. */}
      <span className="sr-only" role="status">
        {loading ? "Loading this learner’s model." : ""}
      </span>

      <NewTopic onDone={refreshTopics} />

      <section className="panel stack learner-goal" aria-labelledby="goal-h">
        <h3 className="eyebrow" id="goal-h">Goal</h3>

        {loading ? (
          <Lines count={1} />
        ) : goalUnknown ? (
          <p className="muted">
            Your goal could not be read — the failure, and its retry, are under “Concept
            record” below. This panel cannot say what your goal is, and setting one would
            retire whatever is already there, so that action is off until the read lands.
          </p>
        ) : activeGoal ? (
          <p className="learner-current">
            Currently <b>{activeGoal.topic}</b> · {depthLabel(activeGoal.depth)}
            {plan && <> · plan v{plan.version}, {plan.steps.length} concepts</>}
            {committed > 0 && <span className="muted"> ({committed} pinned as firm)</span>}
          </p>
        ) : (
          <p className="muted">
            No goal yet. Pick a topic and a depth, and the planner orders the concepts for
            you.
          </p>
        )}

        <div className="row">
          <label className="field">
            topic
            <select value={topicId} onChange={(e) => setTopicId(e.target.value)}>
              {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        </div>

        {/* Depth decides the shape of the whole plan, so it says what each one costs
            rather than offering three unexplained lowercase words. */}
        <div className="learner-field">
          <span className="learner-label" id="depth-label">How deeply?</span>
          <div className="depth-choice" role="group" aria-labelledby="depth-label">
            {["use", "debug", "build"].map((v) => (
              <button
                key={v}
                className={depth === v ? "depth on" : "depth"}
                aria-pressed={depth === v}
                onClick={() => setDepth(v)}
              >
                <strong>{depthLabel(v)}</strong>
                <span>{DEPTH_LABEL[v]?.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="row">
          <button
            ref={primaryRef}
            className="primary"
            // Inert while it would replace a goal with itself, and never renamed for its
            // own status — the label says which of the two acts this is. Also inert while
            // the goal is unknown: the unconfirmed branch below is only safe when the page
            // has actually read that there is no goal to destroy.
            disabled={!dirty || !id || !topicId || goalUnknown}
            aria-disabled={busy !== null}
            onClick={() => {
              if (busy || goalUnknown) return;
              if (activeGoal) setConfirming(true);
              else void applyGoal();
            }}
          >
            {activeGoal ? "Replace plan" : "Set goal & plan"}
          </button>
          <button
            aria-disabled={busy !== null}
            disabled={!plan}
            onClick={() => { if (!busy) void rebuild(); }}
          >
            Replan
          </button>
          {busy === "goal" && <Busy label="building the new plan" clock={false} />}
          {busy === "replan" && <Busy label="reordering your plan" clock={false} />}
        </div>

        <p className="muted learner-hint">
          {goalUnknown
            ? "Replan is still safe — it keeps whatever goal the server holds and re-orders what is left of it. Setting a new goal is not, while this page cannot see the goal it would retire."
            : dirty
            ? "Replace plan starts a new goal and a new plan. Replan keeps your goal and re-orders what is left of it — that is the safe one."
            : "These match your active goal, so there is nothing to replace. Replan re-orders what is left of it against what you now know."}
        </p>

        {confirming && activeGoal && (
          <div
            className="notice notice--warn learner-confirm"
            role="alertdialog"
            aria-labelledby="replace-confirm-h"
            ref={confirmRef}
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setConfirming(false); primaryRef.current?.focus(); }
            }}
          >
            <strong id="replace-confirm-h">Replace your plan?</strong>
            <p>
              This retires your <b>{activeGoal.topic} · {depthLabel(activeGoal.depth)}</b> goal
              {plan && (
                <> and plan v{plan.version} — {plan.steps.length} concepts, {committed} of
                  them pinned as firm</>
              )}
              , and builds a new plan for <b>{targetTopic} · {depthLabel(depth)}</b>.
            </p>
            <p>
              Mastery you have already demonstrated is kept — it lives on the concepts, not
              on the plan. The path through them is what gets rebuilt.
            </p>
            <div className="row">
              <button
                className="primary"
                aria-disabled={busy !== null}
                onClick={() => { if (!busy) void applyGoal(); }}
              >
                Replace it
              </button>
              <button
                onClick={() => { setConfirming(false); primaryRef.current?.focus(); }}
              >
                Keep my current plan
              </button>
              {busy === "goal" && <Busy label="building the new plan" clock={false} />}
            </div>
          </div>
        )}
      </section>

      {/* A failed irreversible write and a successful one used to be the same amber
          banner, on the page where "did my plan just get replaced?" is the question.
          Focused rather than merely announced, because the control that produced it is
          either gone (the confirm) or now inert (nothing left to replace). */}
      {(note || failure) && (
        <div className="learner-result" ref={resultRef} tabIndex={-1}>
          {note && (
            <div className="notice notice--ok learner-note" role="status">
              <div className="row">
                <span>{note}</span>
                <button className="linkish learner-dismiss" onClick={() => setNote(null)}>
                  dismiss
                </button>
              </div>
            </div>
          )}
          {failure && (
            <div className="notice notice--error learner-note" role="alert">
              <strong>That did not go through</strong>
              <p>{failure.message}</p>
              {failure.remedy && <p>{failure.remedy}</p>}
              <button className="linkish learner-dismiss" onClick={() => setFailure(null)}>
                dismiss
              </button>
            </div>
          )}
        </div>
      )}

      <h3 className="section-title">Path</h3>
      {loading ? (
        <Lines />
      ) : planFail && !planFail.missing ? (
        <ReadFailure
          title="Could not load this learner's plan"
          failure={planFail}
          onRetry={() => void load(id)}
        />
      ) : plan ? (
        <>
          {plan.revisionReason && (
            <p className="muted learner-hint">Last change: {plan.revisionReason}</p>
          )}
          {/* Keyed on the version so a replan re-reads it, rather than showing the path
              the banner above has just announced as replaced.

              No onPick: the roadmap's click affordance is "learn →" and "click any concept
              to start it", and this page has nowhere to start a lesson from — /learn takes
              no concept in the URL, so the click landed on a graph node inspector and the
              copy was a lie. The concept links this page can honestly offer are below. */}
          <Roadmap key={`${id}:${plan.version}`} learnerId={id} />

          {/* The roadmap does not draw committed or unlockCount, and "which concepts are
              pinned as firm" was readable on this page before it. Folded away so it
              annotates the roadmap instead of competing with it. */}
          <details className="learner-detail">
            <summary>Plan detail — order, firm steps, and what each concept unlocks</summary>
            <p className="muted learner-hint">
              The roadmap groups this path by milestone; these are the two fields it does
              not draw. <b>Firm</b> is the near horizon the planner committed to when it
              built v{plan.version}. <b>Unlocks</b> counts the later concepts in this plan
              sitting behind this one, which is why it is ordered where it is. Concept names
              open the concept in the graph.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th><th>Concept</th><th>Needs</th><th>Firm</th><th>Unlocks</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.steps.map((st: any) => (
                    <tr key={st.conceptId}>
                      <td className="mono">{st.position + 1}</td>
                      <td>
                        <button className="linkish" onClick={() => openConcept(st.conceptId)}>
                          {st.name}
                        </button>
                      </td>
                      <td className="mono">
                        {st.completed
                          ? "met"
                          : `${st.currentMastery ?? "unknown"} → ${st.requiredLevel}`}
                      </td>
                      <td>{st.committed ? "firm" : "—"}</td>
                      <td className="mono">{st.unlockCount ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : activeGoal ? (
        <div className="empty">You have a goal but no plan for it. Replan builds one.</div>
      ) : goalUnknown ? (
        // The plan read came back empty, but "so set a goal" would be advice built on a
        // goal this page failed to read.
        <div className="empty">
          No plan on the server. Whether there is a goal behind it could not be read — the
          failure is under “Concept record” below.
        </div>
      ) : (
        <div className="empty">
          No plan yet. Pick a topic and a depth above, then set a goal.
        </div>
      )}

      <h3 className="section-title">Probes due before the next step</h3>
      {loading ? (
        <Lines count={2} />
      ) : !plan ? (
        <p className="muted">Nothing to probe until there is a plan.</p>
      ) : plan.probes.length === 0 ? (
        <p className="muted">
          None — the next step can be taught without checking anything first.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Concept</th><th>Kind</th><th>Why</th></tr></thead>
            <tbody>
              {plan.probes.map((p: any) => (
                <tr key={p.conceptId}>
                  <td>
                    <button className="linkish" onClick={() => openConcept(p.conceptId)}>
                      {p.name}
                    </button>
                  </td>
                  <td className="mono">{p.kind}{p.optional ? "" : " (required)"}</td>
                  <td className="muted">{p.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="section-title">
        Concept record{!loading && !stateFail && ` (${states.length})`}
      </h3>
      <p className="muted learner-hint">
        One row per concept this learner has been assessed on — including the ones assessed
        as not established. Confidence runs 0–1 and halves every 45 days, so a fresh 0.40
        and a year-old 0.40 are not the same claim.
      </p>
      <MasteryLegend />

      {loading ? (
        <Lines />
      ) : stateFail ? (
        <ReadFailure
          title={
            stateFail.missing
              ? "This learner is no longer on the server"
              : "Could not load this learner's model"
          }
          failure={stateFail}
          onRetry={() => void load(id)}
        />
      ) : states.length === 0 ? (
        <div className="empty">
          Nothing recorded yet. The intake, or a first lesson, fills this in.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="learner-mastery">
            <thead>
              <tr>
                <th>Concept</th><th>Mastery</th><th>Confidence</th><th>Source</th><th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {states.map((s: any) => (
                <tr key={s.conceptId}>
                  <td data-label="Concept">
                    <button className="linkish" onClick={() => openConcept(s.conceptId)}>
                      {s.name}
                    </button>
                  </td>
                  <td data-label="Mastery">
                    <span className="mastery-mark" data-level={s.mastery} aria-hidden="true" />
                    {" "}{s.mastery}
                  </td>
                  <td className="mono" data-label="Confidence">{s.confidence.toFixed(2)}</td>
                  <td className="mono muted" data-label="Source">{s.source}</td>
                  <td className="muted" data-label="Flags">
                    {s.reprobeQueued || s.blockedUntil ? (
                      <>
                        {s.reprobeQueued && "re-probe queued"}
                        {s.reprobeQueued && s.blockedUntil && " · "}
                        {s.blockedUntil && `blocked until ${shortDate(s.blockedUntil)}`}
                      </>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="section-title">Misconceptions</h3>
      {loading ? (
        <Lines count={2} />
      ) : stateFail ? (
        <p className="muted">Unavailable while the learner model above is failing to load.</p>
      ) : misconceptions.length === 0 ? (
        <p className="muted">No misconceptions on record.</p>
      ) : (
        <>
          <p className="muted learner-hint">
            Every open belief here is put in front of the tutor on every lesson, so a wrong
            one steers teaching until it is cleared. Open the concept to be re-assessed on
            it.
          </p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Concept</th><th>Belief</th><th>Matched failure mode</th></tr></thead>
              <tbody>
                {misconceptions.map((m: any, i: number) => (
                  <tr key={`${m.conceptId}-${i}`}>
                    <td>
                      <button className="linkish" onClick={() => openConcept(m.conceptId)}>
                        {m.name}
                      </button>
                    </td>
                    <td>{m.belief}</td>
                    <td className="muted">{m.matchedFailureMode ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {state?.learner?.variant && (
        <p className="muted learner-arm">
          Experiment arm: <b>{state.learner.variant}</b> —{" "}
          {state.learner.variant === "graph"
            ? "taught through the graph and this learner model."
            : "taught by a plain strong-model tutor with no graph, which is the control the graph is measured against."}{" "}
          Derived from the learner id, so it never changes.
        </p>
      )}
    </div>
  );
}
