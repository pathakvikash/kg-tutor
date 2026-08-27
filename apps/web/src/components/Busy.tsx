import { Elapsed } from "./Elapsed";

/**
 * The app's one busy signal.
 *
 * Eleven sites did `{busy ?? "Label"}` on the button itself and `disabled={busy}`
 * alongside it. That does three bad things at once: it removes the control's accessible
 * name exactly when its state changes, it announces nothing, and disabling a focused
 * element blurs it to <body> — so every turn of every core loop dumped keyboard focus to
 * the top of the document.
 *
 * The convention instead: the control keeps its name and gains aria-disabled, and this
 * sits next to it inside a live region.
 *
 * The latency copy lives in Elapsed and only there, so no page writes its own.
 */
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
