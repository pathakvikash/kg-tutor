import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * The initial assessment, conversational. (07)
 *
 * Three things are asked, not probed — goal, depth and what they already know are not
 * knowledge and cannot be tested. Everything after is a handful of binary-search
 * probes, capped, because the objective is a defensible first step and not an accurate
 * model of the learner.
 */
export function Intake({
  learnerId, topics, onComplete,
}: {
  learnerId: string;
  topics: any[];
  onComplete: () => void;
}) {
  const [stage, setStage] = useState<"ask" | "building" | "goal" | "probing" | "done">("ask");
  const [goalInput, setGoalInput] = useState("");
  const [resolved, setResolved] = useState<any>(null);
  const [job, setJob] = useState<any>(null);
  const [buildQueue, setBuildQueue] = useState<string[]>([]);
  const [resumedFrom, setResumed] = useState<{ topic: string | null; depth: string } | null>(null);
  const [topicId, setTopicId] = useState("");
  const [depth, setDepth] = useState("use");
  const [goalText, setGoalText] = useState("");
  const [alreadyKnow, setAlreadyKnow] = useState("");
  const [session, setSession] = useState<any>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!topicId && topics[0]) setTopicId(topics[0].id); }, [topics, topicId]);

  /**
   * Pick up an assessment that was interrupted. The rows survived a refresh all along;
   * without this the UI silently restarted a half-finished assessment from question one.
   */
  useEffect(() => {
    let cancelled = false;
    void api
      .openIntake(learnerId)
      .then((r) => {
        if (cancelled || !r?.intake) return;
        setSession(r);
        setStage(r.status === "complete" ? "done" : "probing");
        setResumed(r.intake);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [learnerId]);

  /**
   * Free text in, a plan out. A goal is resolved to a topic, anything missing is built,
   * and only then does probing start — so "I want to master backend development" works
   * even when the graph has never heard of it.
   */
  const resolve = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.resolveGoal(goalInput);
      setResolved(r);
      setDepth(r.depth);
      setGoalText(goalInput);

      if (r.kind === "outcome") {
        // An outcome is not teachable; the subjects inside it are.
        const built = await api.createOutcome({
          canonicalName: r.canonicalName, description: r.description, components: r.components,
        });
        const missing = built.components.filter((c: any) => c.conceptCount === 0);
        if (missing.length > 0) {
          setBuildQueue(missing.map((c: any) => c.name));
          setJob(await api.startExpansion(missing[0].name));
          setStage("building");
          return;
        }
        setTopicId(built.components[0]?.id ?? "");
        setStage("goal");
        return;
      }

      if (r.needsExpansion) {
        setBuildQueue([r.canonicalName]);
        setJob(await api.startExpansion(r.canonicalName, r.description));
        setStage("building");
        return;
      }
      setTopicId(r.topicId);
      setStage("goal");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  // Build topics one at a time; each expansion is minutes of model calls.
  useEffect(() => {
    if (stage !== "building" || !job) return;
    const timer = setInterval(async () => {
      try {
        const j = await api.expansion(job.id);
        setJob(j);
        if (j.status === "failed") { setError(j.error); setStage("ask"); return; }
        if (j.status !== "done") return;

        const rest = buildQueue.slice(1);
        if (rest.length > 0) {
          setBuildQueue(rest);
          setJob(await api.startExpansion(rest[0]!));
          return;
        }
        const fresh = await api.topics();
        const match = fresh.find((t: any) => t.name === buildQueue[0]) ?? fresh.find((t: any) => t.concepts > 0);
        if (match) setTopicId(match.id);
        setStage("goal");
      } catch { /* transient */ }
    }, 1200);
    return () => clearInterval(timer);
  }, [stage, job, buildQueue]);

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.startIntake({ learnerId, topicId, depth, goalText, alreadyKnow });
      setSession(r);
      setStage(r.status === "complete" ? "done" : "probing");
      if (r.status === "complete") onComplete();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    if (!answer.trim()) return;
    setBusy(true); setError(null);
    const text = answer;
    setAnswer("");
    try {
      const r = await api.answerIntake(session.intakeId, text);
      setSession(r);
      if (r.status === "complete") { setStage("done"); onComplete(); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const skip = async () => {
    // "I don't know" is a legitimate answer and should cost one question, not a bluff.
    setAnswer("I don't know");
    setBusy(true);
    try {
      const r = await api.answerIntake(session.intakeId, "I don't know");
      setSession(r);
      if (r.status === "complete") { setStage("done"); onComplete(); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); setAnswer(""); }
  };

  if (stage === "ask") {
    return (
      <div className="intake">
        <h2>What do you want to learn?</h2>
        <p className="muted">
          Say it however you'd say it out loud. If it isn't in the graph yet, it gets
          built first.
        </p>
        <textarea
          rows={3}
          value={goalInput}
          onChange={(e) => setGoalInput(e.target.value)}
          placeholder="e.g. I want to master JavaScript &nbsp;·&nbsp; become a backend developer &nbsp;·&nbsp; understand how databases work"
          disabled={busy}
        />
        {error && <p className="err">{error}</p>}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className="primary" onClick={() => void resolve()} disabled={busy || goalInput.trim().length < 3}>
            {busy ? "Working it out…" : "Build my roadmap"}
          </button>
          {topics.length > 0 && (
            <button onClick={() => setStage("goal")} disabled={busy}>
              Pick an existing topic
            </button>
          )}
        </div>
      </div>
    );
  }

  if (stage === "building") {
    const report = job?.report ?? {};
    const events: { kind: string; name: string; detail: string }[] = report.events ?? [];
    // Newest first: a live log the user reads from the top rather than chasing.
    const recent = [...events].reverse().slice(0, 40);

    return (
      <div className="intake wide">
        <h2>Building the graph for {job?.topicName}</h2>
        <p className="muted">
          {resolved?.kind === "outcome"
            ? `"${resolved.canonicalName}" breaks down into ${resolved.components.join(", ")}. Building what's missing.`
            : "Finding the concepts and how they depend on each other."}
        </p>

        <div className="progress" style={{ marginTop: 12 }}>
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
            <p className="muted" style={{ fontSize: 12.5 }}>
              Sampling the model three times for the concept list. Nothing is written
              until a majority agrees, so the first result takes a moment.
            </p>
          ) : (
            <ul className="build-log">
              {recent.map((e, i) => (
                <li key={`${e.kind}-${e.name}-${i}`} className={`ev ${e.kind}`}>
                  <span className="ev-kind">{e.kind.replace(/_/g, " ")}</span>
                  <span className="ev-name">{e.name}</span>
                  <span className="ev-detail">{e.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="muted" style={{ fontSize: 12 }}>
          Each question is asked of the model three times independently and only what a
          majority names is kept — that filter is why this takes minutes, and it is what
          stops the graph filling with plausible-sounding concepts nobody needs.
        </p>
        {error && <p className="err">{error}</p>}
      </div>
    );
  }

  if (stage === "goal") {
    return (
      <div className="intake">
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
            {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>

        <label className="intake-field">
          <span>How deeply?</span>
          <div className="depth-choice">
            {[
              ["use", "Use it", "Get things working"],
              ["debug", "Debug it", "Understand it when it breaks"],
              ["build", "Build with it", "Know it well enough to design with"],
            ].map(([v, label, hint]) => (
              <button
                key={v}
                className={depth === v ? "depth on" : "depth"}
                onClick={() => setDepth(v as string)}
              >
                <strong>{label}</strong>
                <span>{hint}</span>
              </button>
            ))}
          </div>
        </label>

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

        {error && <p className="err">{error}</p>}
        <button className="primary" onClick={() => void start()} disabled={busy || !topicId}>
          {busy ? "Setting up…" : "Start"}
        </button>
      </div>
    );
  }

  if (stage === "probing" && session?.question) {
    return (
      <div className="intake">
        {resumedFrom && (
          <div className="banner" style={{ fontSize: 12.5 }}>
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
        <div className="intake-progress">
          Question {session.asked + 1} of at most {session.budget}
          <div className="progress" style={{ marginTop: 6 }}>
            <div className="bar" style={{ width: `${((session.asked) / session.budget) * 100}%` }} />
          </div>
        </div>
        <h2>{session.question.conceptName}</h2>
        <p className="muted">{session.question.why}</p>
        <div className="bubble" style={{ margin: "12px 0" }}>{session.question.prompt}</div>
        <textarea
          rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)}
          placeholder="In your own words. A rough answer is more useful than a guess."
          disabled={busy}
        />
        {error && <p className="err">{error}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="primary" onClick={() => void submit()} disabled={busy || !answer.trim()}>
            {busy ? "Checking…" : "Answer"}
          </button>
          <button onClick={() => void skip()} disabled={busy}>I don't know this</button>
        </div>
      </div>
    );
  }

  return (
    <div className="intake">
      <h2>Ready</h2>
      <p>
        {session?.asked ?? 0} questions asked. Found {session?.known ?? 0} concepts you already
        have, and built a plan of {session?.plan?.steps ?? 0} concepts across{" "}
        {session?.plan?.milestones ?? 0} milestones.
      </p>
      <p className="muted">
        Everything else gets sorted out while teaching — if the plan turns out wrong, it
        gets revised and you'll be told what changed.
      </p>
      <button className="primary" onClick={onComplete}>Start learning</button>
    </div>
  );
}
