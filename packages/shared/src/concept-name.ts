/**
 * A concept's name has to denote ONE concept.
 *
 * Identity in this graph is canonicalName + sense + neighbourhood, and every downstream
 * mechanism assumes the name refers to a single thing: an assessment item asks the
 * learner to demonstrate it, a mastery level says whether they can, a failure mode says
 * what goes wrong without it. None of that is well-defined for "Arrays or Linked Lists".
 *
 * Expanding "Data Structures" produced 37 concepts of which nine were not concepts:
 * "Hash Functions and Hash Tables", "Recursion or iterative traversal",
 * "Pointers/References and Memory Allocation", "Big-O / Amortized Analysis",
 * "Graph terminology (vertices, edges, directed/undirected, weighted)",
 * "LIFO (Last-In-First-Out) ordering concept", "Graph connectivity concepts",
 * "Variables and memory allocation", "Arrays or Linked Lists". Every one of them names
 * two or more things, and in most cases both halves already existed as their own
 * concept — so the compound could never merge with either, and the graph gained a
 * permanent near-duplicate that can never be taught or assessed coherently.
 *
 * These arrive as invented *prerequisite* names while some other concept is expanded,
 * where the model is describing what a learner needs rather than naming a node. Catching
 * them at proposal time is the only cheap moment: once written they are load-bearing.
 */

export interface ConceptNameCheck {
  ok: boolean;
  reason?: "empty" | "too_long" | "conjunction" | "disjunction" | "parenthetical" | "meta_noun";
  /** The halves, when it split cleanly — a caller may propose them separately. */
  parts?: string[];
}

/** " and " / " & " / " / " joining two noun phrases. */
const CONJUNCTION = /\s+(?:and|&)\s+|\s+\/\s+/i;
/** " or " — a disjunction is never one concept. */
const DISJUNCTION = /\s+or\s+/i;
/** A trailing gloss or enumeration: "Graph terminology (vertices, edges, ...)". */
const PARENTHETICAL_LIST = /\([^)]*,[^)]*\)/;
/**
 * Nouns that describe a *category of* knowledge rather than a thing to know.
 * "Graph connectivity concepts" is a syllabus heading; "graph connectivity" is a concept.
 */
const META_NOUN = /\b(?:concepts?|topics?|fundamentals|basics|terminology|principles|ideas)\s*$/i;

const MAX_WORDS = 8;

/**
 * Heuristic and deliberately conservative: it rejects, it never rewrites. `parts` is
 * offered so a caller can propose the halves individually instead of discarding real
 * prerequisites, which is what "Hash Functions and Hash Tables" actually was.
 */
export function checkConceptName(name: string | null | undefined): ConceptNameCheck {
  const n = (name ?? "").trim();
  if (n.length === 0) return { ok: false, reason: "empty" };
  if (n.split(/\s+/).length > MAX_WORDS) return { ok: false, reason: "too_long" };

  if (PARENTHETICAL_LIST.test(n)) return { ok: false, reason: "parenthetical" };

  // Disjunction first: "Recursion or iterative traversal" must not be read as a
  // conjunction and split into two things the learner needs both of.
  if (DISJUNCTION.test(n)) {
    return { ok: false, reason: "disjunction", parts: split(n, DISJUNCTION) };
  }
  if (CONJUNCTION.test(n)) {
    // "Disjoint Set (Union-Find)" and "Pointers/References" are single concepts whose
    // name carries a synonym. A slash between single words is a synonym, not a join.
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
