export interface ConceptNameCheck {
  ok: boolean;
  reason?: "empty" | "too_long" | "conjunction" | "disjunction" | "parenthetical" | "meta_noun";
  parts?: string[];
}

const CONJUNCTION = /\s+(?:and|&)\s+|\s+\/\s+/i;
const DISJUNCTION = /\s+or\s+/i;
const PARENTHETICAL_LIST = /\([^)]*,[^)]*\)/;
const META_NOUN = /\b(?:concepts?|topics?|fundamentals|basics|terminology|principles|ideas)\s*$/i;

const MAX_WORDS = 8;

/** Conservative heuristic: it rejects, never rewrites */
export function checkConceptName(name: string | null | undefined): ConceptNameCheck {
  const n = (name ?? "").trim();
  if (n.length === 0) return { ok: false, reason: "empty" };
  if (n.split(/\s+/).length > MAX_WORDS) return { ok: false, reason: "too_long" };

  if (PARENTHETICAL_LIST.test(n)) return { ok: false, reason: "parenthetical" };

  // Check disjunction first, so "A or B" is not split into two required things
  if (DISJUNCTION.test(n)) {
    return { ok: false, reason: "disjunction", parts: split(n, DISJUNCTION) };
  }
  if (CONJUNCTION.test(n)) {
    // A slash or "and" between two single words is a synonym, not a join
    const parts = split(n, CONJUNCTION);
    if (parts.every((p) => p.split(/\s+/).length === 1)) return { ok: true };
    return { ok: false, reason: "conjunction", parts };
  }

  if (META_NOUN.test(n)) return { ok: false, reason: "meta_noun" };

  return { ok: true };
}

function split(n: string, re: RegExp): string[] {
  return n
    .split(new RegExp(re.source, "i"))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
