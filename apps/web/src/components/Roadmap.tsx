import { useCallback, useEffect, useState } from "react";
import { api, HttpError, type Mastery } from "../api";
import { atLeast, DEPTH_LABEL, MASTERY_MEANING } from "../vocabulary";

/** Hand-built rather than a model-authored widget: the plan's shape is fixed. */
export function Roadmap({
  learnerId, compact = false, onPick,
}: {
  learnerId: string;
  compact?: boolean;
  /** Clicking a concept starts teaching it. Without this the roadmap is a poster. */
  onPick?: (conceptId: string, name: string) => void;
}) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<{ message: string; remedy: string | null; missing: boolean } | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set([0]));

  const fetchRoadmap = useCallback(() => {
    let cancelled = false;
    setError(null);
    api.roadmap(learnerId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => {
        if (cancelled) return;
        // A missing roadmap is an empty state; anything else is a fault.
        setError({
          message: e instanceof Error ? e.message : String(e),
          remedy: e instanceof HttpError ? e.remedy : null,
          missing: e instanceof HttpError && e.isMissing,
        });
      });
    return () => { cancelled = true; };
  }, [learnerId]);

  useEffect(() => fetchRoadmap(), [fetchRoadmap]);

  if (error) {
    if (error.missing) {
      return (
        <div className="rm">
          <p className="muted empty-line">No roadmap yet — set a goal to get one.</p>
        </div>
      );
    }
    return (
      <div className="rm">
        <div className="notice notice--error" role="alert">
          <strong>The roadmap could not be loaded.</strong>
          <p>{error.message}</p>
          {error.remedy && <p className="muted">{error.remedy}</p>}
          <button onClick={() => fetchRoadmap()}>Try again</button>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rm" aria-busy="true">
        <div className="skeleton skeleton--line skeleton--w40" />
        <div className="skeleton skeleton--line skeleton--w80" />
        <div className="skeleton skeleton--line skeleton--w60" />
        <span className="sr-only" role="status">Loading your roadmap.</span>
      </div>
    );
  }

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
    const met = atLeast(mastery, (s.requiredLevel ?? "functional") as Mastery);
    const body = (
      <>
        {/* The mark carries a shape too, so colour is not the only channel. */}
        <span className="mastery-mark" data-level={mastery} title={MASTERY_MEANING[mastery]} />
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
            {DEPTH_LABEL[data.goal.depth]
              ? `to ${DEPTH_LABEL[data.goal.depth]!.label.toLowerCase()}`
              : data.goal.depth}
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
          (c: any) => atLeast((c.currentMastery ?? "unknown") as Mastery, c.requiredLevel as Mastery),
        ).length;
        const isOpen = open.has(i);
        return (
          <div className={`rm-ms${m.completed ? " complete" : ""}`} key={i}>
            <button className="rm-ms-head" onClick={() => toggle(i)} aria-expanded={isOpen}>
              <span className="rm-caret" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
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
            <span className="rm-caret" aria-hidden="true">{open.has(-1) ? "▾" : "▸"}</span>
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
