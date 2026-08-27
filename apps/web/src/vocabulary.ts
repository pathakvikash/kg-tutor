import type { Mastery } from "./api";

/**
 * One vocabulary for the domain.
 *
 * Five files taught the user five vocabularies for three concepts: the mastery colour map
 * was duplicated in ConceptNode, LearnerPage and Roadmap; the depth labels differed
 * between Intake, LearnerPage and Roadmap; and HomePage defined a KIND_LABEL map and then
 * ignored it in its own chips. If the same state is called different things on different
 * pages, the learner cannot tell it is the same state.
 */

export const MASTERY_ORDER: Mastery[] = ["unknown", "familiar", "functional", "solid"];

export const MASTERY_RANK: Record<Mastery, number> = {
  unknown: 0, familiar: 1, functional: 2, solid: 3,
};

export function atLeast(actual: Mastery, required: Mastery): boolean {
  return MASTERY_RANK[actual] >= MASTERY_RANK[required];
}

/** What each level means to a learner, not to the schema. */
export const MASTERY_MEANING: Record<Mastery, string> = {
  unknown: "not established yet",
  familiar: "can say what it is",
  functional: "can apply it in a familiar setting",
  solid: "can apply it somewhere new, or debug it",
};

export const DEPTH_LABEL: Record<string, { label: string; hint: string }> = {
  use: { label: "Use it", hint: "Get things working" },
  debug: { label: "Debug it", hint: "Understand it when it breaks" },
  build: { label: "Build with it", hint: "Know it well enough to design with" },
};

/** Why a concept is in the review queue. Singular and plural both needed. */
export const DUE_KIND: Record<string, { one: string; many: string; rank: string }> = {
  misconception: {
    one: "wrong belief on record",
    many: "wrong beliefs on record",
    rank: "A recorded belief gets applied, so it does damage until it is cleared.",
  },
  inferred: {
    one: "never demonstrated",
    many: "never demonstrated",
    rank: "Credited from downstream success, so it is cheap to confirm and load-bearing if anything was built on it.",
  },
  decayed: {
    one: "confidence has faded",
    many: "confidence has faded",
    rank: "Held at a real level once; cheaper to re-probe than to re-teach.",
  },
};

export function dueKindLabel(kind: string, count: number): string {
  const entry = DUE_KIND[kind];
  if (!entry) return kind;
  return count === 1 ? entry.one : entry.many;
}
