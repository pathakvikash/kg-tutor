import { useEffect, useState } from "react";

/**
 * A running clock next to a busy label, with the app's one piece of latency copy.
 *
 * Model calls here take tens of seconds. A static "thinking…" is indistinguishable from a
 * hung request, so time has to be visibly passing and the expectation has to be stated up
 * front rather than after the user has already begun to doubt it.
 *
 * The wording used to name the backend ("the CLI backend is the slow part"), which is
 * true, interesting to whoever wrote it, and of no use to someone waiting. It now says
 * how long this usually takes, then escalates: past ~45s it stops claiming normality, and
 * past ~90s it admits the provider's two-minute ceiling instead of spinning into it.
 */
export function Elapsed({ slowAfter = 12 }: { slowAfter?: number }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const note =
    seconds >= 90
      ? "much longer than usual — it will time out at two minutes"
      : seconds >= 45
        ? "longer than usual, still going"
        : seconds > slowAfter
          ? "usually 10–40 seconds"
          : null;

  return (
    <span className="elapsed">
      {seconds}s{note && <em> · {note}</em>}
    </span>
  );
}
