import { useEffect, useState } from "react";
import { Elapsed } from "./Elapsed";

const SLOW_AFTER_MS = 5000;

export function Busy({
  label, slowLabel, clock = true, block = false, onCancel,
}: {
  label: string;
  /** Shown with a clock once the wait passes SLOW_AFTER_MS */
  slowLabel?: string;
  clock?: boolean;
  block?: boolean;
  onCancel?: () => void;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!slowLabel) return;
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [slowLabel]);
  return (
    <div className={block ? "busy busy--block" : "busy"} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{slow && slowLabel ? slowLabel : label}</span>
      {slow && slowLabel && !clock ? <Elapsed start={SLOW_AFTER_MS / 1000} /> : clock && <Elapsed />}
      {onCancel && (
        <button className="linkish" onClick={onCancel}>
          Stop
        </button>
      )}
    </div>
  );
}
