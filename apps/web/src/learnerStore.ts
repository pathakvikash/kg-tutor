import { useEffect, useState } from "react";

const KEY = "kg-tutor:learner";
const listeners = new Set<(id: string) => void>();
let current = read();

function read(): string {
  // Throws outright in some contexts (blocked site data, embedded previews), not
  // only when empty, so this cannot be left unguarded.
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * One learner selection, shared by every consumer.
 *
 * This was a `useState` per call site with no cross-instance sync, so switching learner
 * on Home left the nav's due badge polling the previous learner for the rest of the
 * session — the count in the chrome and the content under it described two different
 * people. A module-level store with a listener set keeps the localStorage semantics the
 * original docstring argued for while making every consumer agree.
 */
export function setLearner(id: string): void {
  if (id === current) return;
  current = id;
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* remembering is a convenience; failing to remember must not break the page */
  }
  for (const fn of listeners) fn(id);
}

export function getLearner(): string {
  return current;
}

export function useLearner(): [string, (id: string) => void] {
  const [id, setId] = useState(current);
  useEffect(() => {
    listeners.add(setId);
    // A different instance may have changed it between render and effect.
    if (current !== id) setId(current);
    return () => { listeners.delete(setId); };
  }, [id]);
  return [id, setLearner];
}

/** The stored learner if the server still knows them, else the first one it does. */
export function resolveLearner(stored: string, learners: { id: string }[]): string {
  if (stored && learners.some((l) => l.id === stored)) return stored;
  return learners[0]?.id ?? "";
}
