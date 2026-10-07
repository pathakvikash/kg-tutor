import { useEffect, useState } from "react";
import { api, HttpError } from "../api";
import { Busy } from "./Busy";
import { Markdown } from "./Markdown";
import { DEPTH_LABEL } from "../vocabulary";

// No cancel endpoint exists; this only stops reattaching to an abandoned build
const DISMISSED_BUILDS = "kg.dismissedBuilds";

function dismissedBuilds(): string[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(DISMISSED_BUILDS) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

export function isDismissedBuild(id: string): boolean {
  return dismissedBuilds().includes(id);
}

function dismissBuild(id: string): void {
  try {
    const all = dismissedBuilds();
    if (!all.includes(id)) {
      sessionStorage.setItem(DISMISSED_BUILDS, JSON.stringify([...all, id].slice(-20)));
    }
  } catch { /* nothing to remember it in */ }
}

export function Intake({
  learnerId, topics, onComplete, onCancel, initialGoal = null,
}: {
  learnerId: string;
  topics: any[];
  onComplete: () => void;
  onCancel?: () => void;
  initialGoal?: string | null;
}) {
  const [stage, setStage] = useState<"ask" | "building" | "goal" | "probing" | "done">("ask");
  const [goalInput, setGoalInput] = useState(initialGoal ?? "");
  const [resolved, setResolved] = useState<any>(null);
  const [job, setJob] = useState<any>(null);
  const [buildQueue, setBuildQueue] = useState<string[]>([]);
  const [resumedFrom, setResumed] = useState<{ topic: string | null; depth: string } | null>(null);
  const [topicId, setTopicId] = useState("");
  // Held in state, not read from the prop, which is stale once a build finishes
  const [topicList, setTopicList] = useState<any[]>(topics);
  const [depth, setDepth] = useState("use");
  const [goalText, setGoalText] = useState("");
  const [alreadyKnow, setAlreadyKnow] = useState("");
  const [session, setSession] = useState<any>(null);
  const [roadmap, setRoadmap] = useState<{ steps: number; milestones: number } | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Consecutive poll failures. One is a blip; five in a row is a lost job */
  const [pollFails, setPollFails] = useState(0);
  const [lostContact, setLostContact] = useState(false);

  useEffect(() => { setTopicList((prev) => (prev.length ? prev : topics)); }, [topics]);
  useEffect(() => { if (!topicId && topicList[0]) setTopicId(topicList[0].id); }, [topicList, topicId]);

  const refreshTopics = async (preferName?: string): Promise<string | null> => {
    try {
      const fresh = await api.topics();
      setTopicList(fresh);
      const match =
        (preferName && fresh.find((t: any) => t.name === preferName)) ??
        fresh.find((t: any) => t.concepts > 0) ?? fresh[0];
      return match?.id ?? null;
    } catch { return null; }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.resumeIntake(learnerId);
        if (cancelled) return;
        if (r?.intake) {
          setSession(r);
          setStage(r.status === "complete" ? "done" : "probing");
          setResumed(r.intake);
          return;
        }
      } catch { /* fall through to the expansion check */ }

      try {
        const jobs = await api.expansions();
        if (cancelled) return;
        const live = jobs.find((j: any) =>
          (j.status === "queued" || j.status === "running") && !isDismissedBuild(j.id));
        if (!live) return;
        setJob(live);
        setBuildQueue([live.topicName]);
        setStage("building");
      } catch { /* nothing to reattach to */ }
    })();
    return () => { cancelled = true; };
  }, [learnerId]);

  const resolve = async () => {
    setBusy("working out what that means"); setError(null);
    try {
      const r = await api.resolveGoal(goalInput);
      setResolved(r);
      setDepth(r.depth);
      setGoalText(goalInput);

      if (r.kind === "outcome") {
        const built = await api.createOutcome({
          canonicalName: r.canonicalName, description: r.description, components: r.components,
        });
        const missing = built.components.filter((c: any) => c.conceptCount === 0);
        if (missing.length > 0) {
          setBuildQueue(missing.map((c: any) => c.name));
          setJob(await api.startExpansion(missing[0].name));
          startBuilding();
          return;
        }
        await refreshTopics(built.components[0]?.name);
        setTopicId(built.components[0]?.id ?? "");
        setStage("goal");
        return;
      }

      if (r.needsExpansion) {
        setBuildQueue([r.canonicalName]);
        setJob(await api.startExpansion(r.canonicalName, r.description));
        startBuilding();
        return;
      }
      await refreshTopics(r.canonicalName);
      setTopicId(r.topicId);
      setStage("goal");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  /* Derived here because StrictMode double-invokes state updaters */
  useEffect(() => { if (pollFails >= 5) setLostContact(true); }, [pollFails]);

  const startBuilding = () => {
    setPollFails(0); setLostContact(false); setError(null); setStage("building");
  };

  useEffect(() => {
    if (stage !== "building" || !job || lostContact || job.status === "failed") return;
    const timer = setInterval(async () => {
      try {
        const j = await api.expansion(job.id);
        setPollFails(0);
        setJob(j);
        if (j.status === "failed") { setError(j.error ?? "the build failed"); return; }
        if (j.status !== "done") return;

        const rest = buildQueue.slice(1);
        if (rest.length > 0) {
          setBuildQueue(rest);
          setJob(await api.startExpansion(rest[0]!));
          return;
        }
        const id = await refreshTopics(buildQueue[0]);
        if (id) setTopicId(id);
        setStage("goal");
      } catch (e) {
        // A 404 means the job is gone; anything else only counts after a run of them
        const fatal = e instanceof HttpError && e.isMissing;
        setPollFails((n) => n + 1);
        if (fatal) setLostContact(true);
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [stage, job, buildQueue, lostContact]);

  const retryBuild = async () => {
    if (!job) return;
    setBusy("restarting the build"); setError(null);
    try {
      const j = await api.retryExpansion(job.id);
      setJob(j);
      startBuilding();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const startOver = () => {
    if (job?.id) dismissBuild(job.id);
    setStage("ask"); setJob(null); setBuildQueue([]); setResolved(null);
    setError(null); setPollFails(0); setLostContact(false);
    setGoalInput((prev) => prev || goalText || "");
  };

  const start = async () => {
    setBusy("setting up your assessment"); setError(null);
    try {
      const r = await api.startIntake({ learnerId, topicId, depth, goalText, alreadyKnow });
      setSession(r);
      if (r.plan) setRoadmap({ steps: r.plan.steps, milestones: r.plan.milestones });
      setStage(r.status === "complete" ? "done" : "probing");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const answerWith = async (text: string, label: string) => {
    if (!text.trim() || busy) return;
    setBusy(label); setError(null);
    try {
      const r = await api.answerIntake(session.intakeId, text);
      setSession(r);
      setAnswer("");
      if (r.status === "complete") setStage("done");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const submit = () => void answerWith(answer, "checking your answer");
  const skip = () => void answerWith("I don't know", "recording that");

  if (stage === "ask") {
    return (
      <div className="intake page--narrow">
        <h2>What do you want to learn?</h2>
        <p className="muted">
          Say it however you'd say it out loud. If it isn't in the graph yet, it gets
          built first.
        </p>
        <textarea
          rows={3}
          value={goalInput}
          onChange={(e) => setGoalInput(e.target.value)}
          placeholder="e.g. I want to master JavaScript · become a backend developer · understand how databases work"
        />
        {error && (
          <div className="notice notice--error" role="alert">
            <strong>That goal could not be worked out.</strong>
            {error}
          </div>
        )}
        <div className="row intake-actions">
          <button
            className="primary"
            onClick={() => void resolve()}
            aria-disabled={!!busy || undefined}
            disabled={goalInput.trim().length < 3}
          >
            Build my roadmap
          </button>
          {topicList.length > 0 && (
            <button onClick={() => setStage("goal")} aria-disabled={!!busy || undefined}>
              Pick an existing topic
            </button>
          )}
          {onCancel && (
            <button className="linkish" onClick={onCancel}>back to the lesson</button>
          )}
          {busy && <Busy label={busy} />}
        </div>
      </div>
    );
  }

  if (stage === "building") {
    const report = job?.report ?? {};
    const events: { kind: string; name: string; detail: string }[] = report.events ?? [];
    // Newest first, keyed by content: a reversed index changes key on every poll
    const recent = [...events].reverse().slice(0, 40);
    const failed = job?.status === "failed";

    return (
      <div className="intake wide">
        <h2>Building the graph for {job?.topicName}</h2>
        <p className="muted">
          {resolved?.kind === "outcome"
            ? `"${resolved.canonicalName}" breaks down into ${resolved.components.join(", ")}. Building what's missing.`
            : "Finding the concepts and how they depend on each other."}
        </p>

        {pollFails > 1 && !lostContact && (
          <p className="muted build-hint" role="status">
            Not hearing back from the build — still asking.
          </p>
        )}

        {lostContact && (
          <div className="notice notice--error" role="alert">
            <strong>Lost contact with this build.</strong>
            <p>
              It stopped answering. The work may still be running server-side, or the job
              may be gone — either way nothing more will appear here on its own.
            </p>
            {error && (
              <p className="retry-failed">
                <strong>That retry did not take:</strong> {error}
              </p>
            )}
            <div className="row">
              <button className="primary" onClick={() => void retryBuild()} aria-disabled={!!busy || undefined}>
                Retry the build
              </button>
              <button onClick={startOver}>Not what I meant — start over</button>
              {busy && <Busy label={busy} clock={false} />}
            </div>
          </div>
        )}

        {failed && !lostContact && (
          <div className="notice notice--error" role="alert">
            <strong>The build failed.</strong>
            <p>{error ?? job?.error}</p>
            <p className="muted">
              Your goal is still here: “{goalText || goalInput}”. Retrying picks up from
              what was already written.
            </p>
            <div className="row">
              <button className="primary" onClick={() => void retryBuild()} aria-disabled={!!busy || undefined}>
                Try the build again
              </button>
              <button onClick={startOver}>Not what I meant — start over</button>
              {busy && <Busy label={busy} clock={false} />}
            </div>
          </div>
        )}

        <div className="progress build-progress">
          <div className="bar" style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }} />
        </div>
        <div className="build-stats">
          <span>{job?.phase}</span>
          <span className="spacer" />
          {report.conceptsCreated > 0 && <span><b>{report.conceptsCreated}</b> new</span>}
          {report.conceptsBound > 0 && <span><b>{report.conceptsBound}</b> reused</span>}
          {report.edgesWritten > 0 && <span><b>{report.edgesWritten}</b> edges</span>}
          {report.edgesDemoted > 0 && <span><b>{report.edgesDemoted}</b> demoted</span>}
        </div>

        {report.conceptsFound?.length > 0 && (
          <div className="build-section">
            <h4>Concepts that survived consensus ({report.conceptsFound.length})</h4>
            <div className="chips">
              {report.conceptsFound.map((c: any) => (
                <span className="chip" key={c.name} title={`named by ${c.votes} of 3 samples`}>
                  {c.name} <em>{c.votes}/3</em>
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="build-section">
          <h4>Live</h4>
          {recent.length === 0 ? (
            <p className="muted build-hint">
              Sampling the model three times for the concept list. Nothing is written
              until a majority agrees, so the first result takes a moment.
            </p>
          ) : (
            <ul className="build-log">
              {recent.map((e) => (
                <li key={`${e.kind}-${e.name}-${e.detail}`} className={`ev ${e.kind}`}>
                  <span className="ev-kind">{e.kind.replace(/_/g, " ")}</span>
                  <span className="ev-name">{e.name}</span>
                  <span className="ev-detail">{e.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="muted build-hint">
          Each question is asked of the model three times independently and only what a
          majority names is kept — that filter is why this takes minutes, and it is what
          stops the graph filling with plausible-sounding concepts nobody needs.
        </p>

        {!failed && !lostContact && (
          <div className="row intake-actions">
            <button onClick={startOver}>Not what I meant — start over</button>
            {onCancel && (
              <button className="linkish" onClick={onCancel}>
                leave it running and go back
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  if (stage === "goal") {
    return (
      <div className="intake page--narrow">
        <h2>Before we start</h2>
        <p className="muted">
          {resolved
            ? `Aiming at ${resolved.canonicalName}. A few questions so the first lesson lands in the right place.`
            : "A few questions so the first lesson lands in the right place."}
          {" "}Under a minute — the teaching itself does most of the assessing.
        </p>

        <label className="intake-field">
          <span>What do you want to learn?</span>
          <select value={topicId} onChange={(e) => setTopicId(e.target.value)}>
            {topicList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>

        {/* A fieldset, not a label: <button> is labelable and would be activated */}
        <fieldset className="intake-field depth-set">
          <legend>How deeply?</legend>
          <div className="depth-choice">
            {Object.entries(DEPTH_LABEL).map(([v, { label, hint }]) => (
              <button
                key={v}
                type="button"
                aria-pressed={depth === v}
                className={depth === v ? "depth on" : "depth"}
                onClick={() => setDepth(v)}
              >
                <span className="depth-mark" aria-hidden="true">{depth === v ? "●" : "○"}</span>
                <strong>{label}</strong>
                <span>{hint}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <label className="intake-field">
          <span>What are you aiming to do with it? <em className="muted">(optional)</em></span>
          <input
            value={goalText} onChange={(e) => setGoalText(e.target.value)}
            placeholder="e.g. build a small web app end to end"
          />
        </label>

        <label className="intake-field">
          <span>Anything here you already know? <em className="muted">(optional)</em></span>
          <input
            value={alreadyKnow} onChange={(e) => setAlreadyKnow(e.target.value)}
            placeholder="e.g. functions, scope"
          />
          <em className="muted hint">
            This only decides where to start asking. It never skips a concept on its own —
            self-report is a hint, not evidence.
          </em>
        </label>

        {error && (
          <div className="notice notice--error" role="alert">
            <strong>The assessment could not be started.</strong>
            {error}
          </div>
        )}
        <div className="row intake-actions">
          <button
            className="primary"
            onClick={() => void start()}
            aria-disabled={!!busy || undefined}
            disabled={!topicId}
          >
            Start
          </button>
          <button onClick={startOver} aria-disabled={!!busy || undefined}>
            Change the goal
          </button>
          {onCancel && (
            <button className="linkish" onClick={onCancel}>back to the lesson</button>
          )}
          {busy && <Busy label={busy} />}
        </div>
      </div>
    );
  }

  if (stage === "probing" && session?.question) {
    return (
      <div className="intake page--narrow">
        {resumedFrom && (
          <div className="notice notice--info">
            Picking up where you left off — {resumedFrom.topic ?? "your assessment"} (
            {resumedFrom.depth}).{" "}
            <button
              className="linkish"
              onClick={() => {
                void api.abandonIntake(session.intakeId).then(() => {
                  setResumed(null); setSession(null); setStage("ask");
                });
              }}
            >
              start something else instead
            </button>
          </div>
        )}
        {session.lastAnswer && (
          <div className={session.lastAnswer.correct ? "verdict ok" : "verdict gap"}>
            <strong>
              {session.lastAnswer.correct
                ? `${session.lastAnswer.conceptName} — solid.`
                : `${session.lastAnswer.conceptName} — not yet.`}
            </strong>{" "}
            <span className="verdict-why"><Markdown text={session.lastAnswer.reasoning} /></span>
          </div>
        )}
        {roadmap && (
          <p className="muted probe-hint">
            Your roadmap is built — <b>{roadmap.steps}</b> concepts
            {roadmap.milestones > 0 ? ` across ${roadmap.milestones} milestones` : ""}. These
            questions only decide where you start and what gets skipped, so answering more
            of them means being taught less.
          </p>
        )}
        <div className="intake-progress">
          Question {session.asked + 1} of at most {session.budget}
          <div className="progress probe-progress">
            <div className="bar" style={{ width: `${((session.asked) / session.budget) * 100}%` }} />
          </div>
        </div>
        <h2>{session.question.conceptName}</h2>
        <p className="muted">{session.question.why}</p>
        <div className="bubble probe-prompt">
          <Markdown text={session.question.prompt} />
          {session.question.code && (
            <Markdown
              text={`\`\`\`${session.question.codeLanguage ?? ""}\n${session.question.code}\n\`\`\``}
            />
          )}
        </div>
        <textarea
          rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)}
          placeholder="In your own words. A rough answer is more useful than a guess."
        />
        {error && (
          <div className="notice notice--error" role="alert">
            <strong>That answer was not recorded.</strong>
            <p>{error}</p>
            <p className="muted">Your text is still in the box — send it again.</p>
          </div>
        )}
        <div className="row intake-actions">
          <button
            className="primary"
            onClick={submit}
            aria-disabled={!!busy || undefined}
            disabled={!answer.trim()}
          >
            Answer
          </button>
          {busy && <Busy label={busy} />}
          <span className="spacer" />
          <button className="linkish quiet" onClick={skip} aria-disabled={!!busy || undefined}>
            I don't know this one
          </button>
        </div>
      </div>
    );
  }

  const known: string[] = session?.knownConcepts ?? [];
  return (
    <div className="intake page--narrow">
      <h2>Assessment done</h2>
      <p>
        {session?.asked ?? 0} question{session?.asked === 1 ? "" : "s"} asked, and a plan of{" "}
        <b>{session?.plan?.steps ?? 0}</b> concepts across{" "}
        <b>{session?.plan?.milestones ?? 0}</b> milestone
        {session?.plan?.milestones === 1 ? "" : "s"}.
      </p>

      {known.length > 0 ? (
        <div className="intake-field">
          <span>Already yours, so nothing here gets taught again</span>
          <div className="chips">
            {known.map((n) => <span className="chip" key={n}>{n}</span>)}
          </div>
        </div>
      ) : (
        <p className="muted">
          Nothing came back as already solid, so the plan starts from the ground up.
          That is a starting point, not a verdict — the teaching keeps assessing.
        </p>
      )}

      {session?.startsWith && (
        <p>
          Starting with <b>{session.startsWith}</b>.
        </p>
      )}

      <p className="muted">
        Everything else gets sorted out while teaching — if the plan turns out wrong, it
        gets revised and you'll be told what changed.
      </p>
      <button className="primary" onClick={onComplete}>Start learning</button>
    </div>
  );
}
