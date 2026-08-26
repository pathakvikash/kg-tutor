import { useEffect, useState } from "react";
import { api, type Mastery } from "../api";

const RANK: Record<Mastery, number> = { unknown: 0, familiar: 1, functional: 2, solid: 3 };
const DOT: Record<Mastery, string> = {
  unknown: "var(--m-unknown)", familiar: "var(--m-familiar)",
  functional: "var(--m-functional)", solid: "var(--m-solid)",
};

/**
 * The roadmap, as a first-class component rather than a model-authored widget.
 *
 * The interactive lesson widgets are model-authored because their content is different
 * every time. A roadmap is not: it is Plan, PlanStep and MilestoneInstance rows whose
 * shape we own. Asking a model to lay out data we already have would make it slower,
 * less consistent, and occasionally wrong about the learner's own progress.
 *
 * Grouped by milestone because a flat list of nineteen concepts reads as a wall, while
 * "you can predict the order of asynchronous output — 2 of 4" is a thing worth
 * finishing.
 */
export function Roadmap({
  learnerId, compact = false, onPick,
}: {
  learnerId: string;
  compact?: boolean;
  /** Clicking a concept starts teaching it. Without this the roadmap is a poster. */
  onPick?: (conceptId: string, name: string) => void;
}) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set([0]));

  useEffect(() => {
    let cancelled = false;
    api.roadmap(learnerId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [learnerId]);

  if (error) return <div className="rm"><p className="muted">{error}</p></div>;
  if (!data) return <div className="rm"><p className="muted">Loading your roadmap…</p></div>;

  const claimed = new Set(data.milestones.flatMap((m: any) => m.concepts.map((c: any) => c.id)));
  const loose = data.steps.filter((s: any) => !claimed.has(s.conceptId));
  const pct = data.totalConcepts === 0 ? 0 : Math.round((data.completed / data.totalConcepts) * 100);

  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });

  const Step = ({ s }: { s: any }) => {
    const mastery = (s.currentMastery ?? "unknown") as Mastery;
    const met = RANK[mastery] >= RANK[(s.requiredLevel ?? "functional") as Mastery];
    const body = (
      <>
        <span className="rm-dot" style={{ background: DOT[mastery] }} />
        <span className="rm-name">{s.name}</span>
        <span className="rm-level">{met ? "done" : `${mastery} → ${s.requiredLevel}`}</span>
        {onPick && <span className="rm-go">{met ? "revisit" : "learn"} →</span>}
      </>
    );
    if (!onPick) return <div className={`rm-step${met ? " met" : ""}`}>{body}</div>;
    return (
      <button
        className={`rm-step actionable${met ? " met" : ""}`}
        onClick={() => onPick(s.conceptId, s.name)}
        title={`Start a lesson on ${s.name}`}
      >
        {body}
      </button>
    );
  };

  return (
    <div className={compact ? "rm compact" : "rm"}>
      <div className="rm-head">
        <div>
          <div className="rm-goal">{data.goal.topic}</div>
          <div className="rm-sub">
            {data.goal.depth === "build" ? "to build with it"
              : data.goal.depth === "debug" ? "to debug it"
              : "to use it"}
            {" · plan v"}{data.version}
          </div>
        </div>
        <div className="rm-pct">{pct}%</div>
      </div>
      <div className="progress"><div className="bar" style={{ width: `${pct}%` }} /></div>
      <div className="rm-count">
        {data.completed} of {data.totalConcepts} concepts
        {onPick && <span> · click any concept to start it</span>}
      </div>

      {data.milestones.map((m: any, i: number) => {
        const done = m.concepts.filter(
          (c: any) => RANK[(c.currentMastery ?? "unknown") as Mastery] >= RANK[c.requiredLevel as Mastery],
        ).length;
        const isOpen = open.has(i);
        return (
          <div className={`rm-ms${m.completed ? " complete" : ""}`} key={i}>
            <button className="rm-ms-head" onClick={() => toggle(i)} aria-expanded={isOpen}>
              <span className="rm-caret">{isOpen ? "▾" : "▸"}</span>
              <span className="rm-claim">{m.claim}</span>
              <span className="rm-ms-count">{done}/{m.concepts.length}</span>
            </button>
            {m.foldedForward && (
              <div className="rm-note">
                Mostly already satisfied, so it folds into the next one rather than
                handing you a completion you did not earn.
              </div>
            )}
            {isOpen && (
              <div className="rm-steps">
                {m.concepts.map((c: any) => <Step key={c.id} s={{ ...c, conceptId: c.id }} />)}
              </div>
            )}
          </div>
        );
      })}

      {loose.length > 0 && (
        <div className="rm-ms">
          <button className="rm-ms-head" onClick={() => toggle(-1)} aria-expanded={open.has(-1)}>
            <span className="rm-caret">{open.has(-1) ? "▾" : "▸"}</span>
            <span className="rm-claim">Groundwork</span>
            <span className="rm-ms-count">{loose.length}</span>
          </button>
          {open.has(-1) && (
            <div className="rm-steps">
              {loose.map((s: any) => <Step key={s.conceptId} s={s} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
