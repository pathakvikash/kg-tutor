import { Elapsed } from "./Elapsed";

/** Sits beside a control that keeps its name and gains aria-disabled. */
export function Busy({
  label, clock = true, block = false, onCancel,
}: {
  /** What is happening, in the learner's terms. "grading", not "POST /attempt". */
  label: string;
  /** Show the running clock. Off for sub-second work, where it is just noise. */
  clock?: boolean;
  block?: boolean;
  onCancel?: () => void;
}) {
  return (
    <div className={block ? "busy busy--block" : "busy"} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
      {clock && <Elapsed />}
      {onCancel && (
        <button className="linkish" onClick={onCancel}>
          stop
        </button>
      )}
    </div>
  );
}
