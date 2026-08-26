import { useCallback, useState } from "react";

const KEY = "kg-tutor:learner";

/**
 * The chosen learner, remembered across pages and refreshes.
 *
 * Every page picked its own default — usually the first row the API returned — so
 * choosing someone on the graph and then opening the lesson page silently switched who
 * you were looking at, and a refresh reset all of them. Which learner you are working on
 * is a property of the session, not of one screen.
 *
 * localStorage rather than the URL for this one: it has to survive navigation between
 * pages, and it is not part of what you would share. Page-specific view state — topic,
 * selected node, focus — stays in the URL, where a link can carry it.
 */
export function useStickyLearner(): [string, (id: string) => void] {
  const [id, setId] = useState<string>(() => {
    // Throws outright in some contexts (blocked site data, embedded previews), not just
    // when empty, so reading it cannot be left unguarded.
    try {
      return localStorage.getItem(KEY) ?? "";
    } catch {
      return "";
    }
  });

  const set = useCallback((next: string) => {
    setId(next);
    try {
      if (next) localStorage.setItem(KEY, next);
      else localStorage.removeItem(KEY);
    } catch {
      /* remembering is a convenience; failing to remember must not break the page */
    }
  }, []);

  return [id, set];
}

/** The stored learner if the server still knows them, else the first one it does. */
export function resolveLearner(stored: string, learners: { id: string }[]): string {
  if (stored && learners.some((l) => l.id === stored)) return stored;
  return learners[0]?.id ?? "";
}
