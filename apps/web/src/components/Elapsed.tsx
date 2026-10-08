import { useEffect, useState } from "react";

export function Elapsed({ slowAfter = 12, start = 0 }: { slowAfter?: number; start?: number }) {
  const [seconds, setSeconds] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const note =
    seconds >= 90
      ? "much longer than usual, it will time out at two minutes"
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
