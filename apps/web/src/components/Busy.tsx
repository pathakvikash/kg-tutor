import { Elapsed } from "./Elapsed";

export function Busy({
  label, clock = true, block = false, onCancel,
}: {
  label: string;
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
