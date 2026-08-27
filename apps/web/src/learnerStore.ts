import { useEffect, useState } from "react";

const KEY = "kg-tutor:learner";
const listeners = new Set<(id: string) => void>();
let current = read();

function read(): string {
  // localStorage can throw, not just return empty, when site data is blocked.
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

/** Module-level store, so every consumer sees the same learner. */
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
