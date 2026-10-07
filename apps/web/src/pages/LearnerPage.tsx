import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { resolveLearner, useStickyLearner } from "../useLearner";
import { api, HttpError } from "../api";
import { Busy } from "../components/Busy";
import { Roadmap } from "../components/Roadmap";
import { DEPTH_LABEL, MASTERY_MEANING, MASTERY_ORDER } from "../vocabulary";

type Failure = { message: string; remedy: string | null; missing: boolean };

function asFailure(e: unknown): Failure {
  if (e instanceof HttpError) return { message: e.message, remedy: e.remedy, missing: e.isMissing };
  return { message: e instanceof Error ? e.message : String(e), remedy: null, missing: false };
}

type Read<T> = { ok: true; value: T } | { ok: false; failure: Failure };

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

function Lines({ count = 3 }: { count?: number }) {
  const widths = ["skeleton--w80", "skeleton--w60", "skeleton--w40"];
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

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Gated throughout: the write is shared across learners and irreversible */
function NewTopic({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [job, setJob] = useState<any>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [lost, setLost] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const buildRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);

  // Focus the dialog, not the confirm button, so a held Enter cannot fall through
  useEffect(() => { if (confirming) confirmRef.current?.focus(); }, [confirming]);

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
          // Enter moves to the button rather than committing a shared, irreversible write
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
  /** Which load is current. A slow first response must not land under a second learner */
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
  const goalUnknown = stateFail !== null;

  useEffect(() => {
    if (loading) return;
    if (activeGoal) { setTopicId(activeGoal.topicId); setDepth(activeGoal.depth); }
    else { setTopicId(""); setDepth("use"); }
  }, [id, loading, activeGoal?.id, activeGoal?.topicId, activeGoal?.depth]);

  useEffect(() => {
    if (!activeGoal && !topicId && topics[0]) setTopicId(topics[0].id);
  }, [activeGoal, topicId, topics]);

  useEffect(() => { setNote(null); setFailure(null); setConfirming(false); }, [id, topicId, depth]);

  useEffect(() => { if (note || failure) resultRef.current?.focus(); }, [note, failure]);

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
            {learners.map((l) => <option key={l.id} value={l.id}>{l.email ?? l.name ?? l.id}</option>)}
          </select>
        </label>
      </div>

      {/* Mounted unconditionally: a region that appears already holding its text may never be spoken */}
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
          <Roadmap key={`${id}:${plan.version}`} learnerId={id} />

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
