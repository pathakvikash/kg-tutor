import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Markdown } from "../components/Markdown";
import { resolveLearner, useStickyLearner } from "../useLearner";

/** Singular and plural, because "3 wrong belief on record" reads as a bug. */
const KIND_LABEL: Record<string, [one: string, many: string]> = {
  misconception: ["wrong belief on record", "wrong beliefs on record"],
  inferred: ["never demonstrated", "never demonstrated"],
  decayed: ["confidence has faded", "confidence has faded"],
};

/**
 * Where a session starts.
 *
 * Every other page assumed you already knew what you wanted: the lesson page opens on
 * whatever the plan says, the graph opens on everything at once. Nothing ever said "two
 * concepts are due, one assessment is unfinished, and the next step is X" — so deciding
 * what to do meant checking three pages, and the review queue in particular was
 * invisible because nothing rendered it at all.
 */
export function HomePage() {
  const [learners, setLearners] = useState<any[]>([]);
  const [learnerId, setLearnerId] = useStickyLearner();
  const [due, setDue] = useState<any>(null);
  const [plan, setPlan] = useState<any>(null);
  const [intake, setIntake] = useState<any>(null);
  const [builds, setBuilds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    void api.learners().then((l) => { setLearners(l); setLearnerId(resolveLearner(learnerId, l)); });
  }, []);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    // Independent reads, so one slow or missing answer must not hide the rest.
    const [d, p, i, b] = await Promise.all([
      api.due(id).catch(() => null),
      api.plan(id).catch(() => null),
      api.openIntake(id).catch(() => null),
      api.expansions().catch(() => []),
    ]);
    setDue(d); setPlan(p); setIntake(i?.intake ? i : null);
    setBuilds((b ?? []).filter((j: any) => j.status === "queued" || j.status === "running"));
    setLoading(false);
  }, []);

  useEffect(() => { void load(learnerId); }, [learnerId, load]);

  const nextStep = plan?.steps?.find((s: any) => !s.completed) ?? null;
  const dueCount = due?.total ?? 0;

  return (
    <div className="page home">
      <div className="home-head">
        <div>
          <h2>Where you left off</h2>
          <p className="muted">
            {loading ? "Checking…" : "Everything waiting on you, in one place."}
          </p>
        </div>
        <label className="field">
          learner
          <select value={learnerId} onChange={(e) => setLearnerId(e.target.value)}>
            {learners.map((l) => <option key={l.id} value={l.id}>{l.email}</option>)}
          </select>
        </label>
      </div>

      <div className="home-cards">
        {/* Ordered by what it costs to ignore: an unresolved wrong belief gets applied,
            an unfinished assessment blocks a plan, a due review quietly rots. */}
        {intake && (
          <article className="card urgent">
            <h4>Assessment unfinished</h4>
            <p>
              {intake.intake.topic ?? "An assessment"} ({intake.intake.depth}) is part-way
              through. Your roadmap already exists; these questions decide what gets skipped.
            </p>
            <Link className="btn primary" to="/learn">Pick it up</Link>
          </article>
        )}

        <article className={dueCount > 0 ? "card urgent" : "card"}>
          <h4>Due for review</h4>
          {dueCount === 0 ? (
            <p className="muted">
              Nothing has faded and no wrong beliefs are on record. Confidence decays on a
              45-day half life, so this fills up on its own.
            </p>
          ) : (
            <>
              <p>
                <b>{dueCount}</b> concept{dueCount === 1 ? "" : "s"} —{" "}
                {(["misconception", "inferred", "decayed"] as const)
                  .filter((k) => due.byKind[k] > 0)
                  .map((k) => `${due.byKind[k]} ${KIND_LABEL[k]![due.byKind[k] === 1 ? 0 : 1]}`)
                  .join(", ")}
                .
              </p>
              <Link className="btn primary" to="/review-session">Start review</Link>
            </>
          )}
        </article>

        <article className="card">
          <h4>Next in the plan</h4>
          {nextStep ? (
            <>
              <p>
                <b>{nextStep.name}</b> — {nextStep.currentMastery} → {nextStep.requiredLevel}
                {plan.goal?.topic ? ` · ${plan.goal.topic}` : ""}
              </p>
              <Link className="btn primary" to="/learn">Continue</Link>
            </>
          ) : plan ? (
            <p className="muted">
              Every step on the current plan is satisfied. Set a new goal, or explore the
              graph and assess yourself on anything.
            </p>
          ) : (
            <p className="muted">No plan yet. Start one from the lesson page.</p>
          )}
        </article>

        {builds.length > 0 && (
          <article className="card">
            <h4>Building</h4>
            {builds.map((j) => (
              <p key={j.id}>
                <b>{j.topicName}</b> — {j.phase} ·{" "}
                {Math.round((j.progress ?? 0) * 100)}%
              </p>
            ))}
            <p className="muted" style={{ fontSize: 12 }}>
              Expansion samples the model three times per question and keeps only what a
              majority names, which is why it takes minutes. It survives a refresh.
            </p>
          </article>
        )}
      </div>

      {dueCount > 0 && (
        <section className="home-list">
          <h4>What is due, and why</h4>
          {due.items.slice(0, 8).map((it: any) => (
            <button
              key={it.conceptId}
              className="due-row"
              onClick={() => navigate(`/graph?node=${it.conceptId}&learner=${learnerId}`)}
              title="Open this concept in the graph"
            >
              <span className={`due-kind ${it.kind}`}>{it.kind}</span>
              <span className="due-name">{it.conceptName}</span>
              <span className="due-why">{it.reason}</span>
              {it.belief && (
                <span className="due-belief">
                  <Markdown text={`Recorded belief: ${it.belief}`} />
                </span>
              )}
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
