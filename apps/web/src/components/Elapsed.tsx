import { useEffect, useState } from "react";

/**
 * A running clock next to a busy label.
 *
 * Model calls here take tens of seconds. A static "thinking…" is indistinguishable from
 * a hung request, and the honest fix — until responses stream — is to show that time is
 * passing and roughly how long this usually takes.
 */
export function Elapsed({ slowAfter = 12 }: { slowAfter?: number }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="elapsed">
      {seconds}s
      {seconds > slowAfter && (
        <em> · model calls run 10–40s here; the CLI backend is the slow part</em>
      )}
    </span>
  );
}
