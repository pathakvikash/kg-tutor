import { useEffect, useState } from "react";

const KEY = "kg-tutor:learner";
const listeners = new Set<(id: string) => void>();
let current = read();

function read(): string {
  // localStorage can throw, not just return empty, when site data is blocked
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

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
    if (current !== id) setId(current);
    return () => { listeners.delete(setId); };
  }, [id]);
  return [id, setLearner];
}

export function resolveLearner(stored: string, learners: { id: string }[]): string {
  if (stored && learners.some((l) => l.id === stored)) return stored;
  return learners[0]?.id ?? "";
}
