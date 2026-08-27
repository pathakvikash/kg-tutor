// A hard edge costs a named failure mode, which is the hallucination filter. (03, 15)

export interface FailureModeCheck {
  ok: boolean;
  /** Why it was rejected — surfaced to the review queue, not swallowed. */
  reason?: "too_short" | "circular" | "vague" | "restates_target";
}

/** Phrasings that assert a failure without describing one. */
const VAGUE = [
  // Negated comprehension, in any of the ways it gets phrased.
  /\b(?:won'?t|will not|can'?t|cannot|couldn'?t|doesn'?t|does not|unable to)\s+(?:really\s+|fully\s+|properly\s+|truly\s+)?(?:understand|grasp|get|follow|learn|make sense of)\b/i,
  /\bwill(?: be)?\s+(?:get\s+)?confus(?:ed|ing)\b/i,
  /\bwill struggle\b/i,
  /\blacks?\s+(?:the\s+)?(?:foundation|basics|background|groundwork)\b/i,
  // Asserting that the prerequisite is required is not describing a failure.
  /\bis\s+(?:a\s+)?(?:necessary|required|essential|fundamental)\s+(?:prerequisite|foundation|building block)\b/i,
  /\bneeds?\s+to\s+know\s+(?:this|it|that)\s+first\b/i,
  /\bit'?s\s+(?:important|fundamental|foundational|essential)\b/i,
];

const MIN_WORDS = 6;

function words(s: string): string[] {
  return s.toLowerCase().split(/\W+/).filter(Boolean);
}

/** Must describe a wrong belief, not that the prerequisite is needed; a rejection demotes to soft. */
export function checkFailureMode(
  text: string | null | undefined,
  opts: { sourceName: string; targetName: string },
): FailureModeCheck {
  const t = (text ?? "").trim();
  if (words(t).length < MIN_WORDS) return { ok: false, reason: "too_short" };

  const lower = t.toLowerCase();
  const src = opts.sourceName.trim().toLowerCase();
  const tgt = opts.targetName.trim().toLowerCase();

  // "Without closures, the learner won't understand closures."
  if (src && lower.includes(src)) {
    const withoutSource = lower.split(src).join(" ");
    if (words(withoutSource).length < MIN_WORDS) return { ok: false, reason: "circular" };
  }

  // Naming only the target and asserting failure describes nothing.
  if (tgt && lower.includes(tgt)) {
    const rest = lower.split(tgt).join(" ");
    if (words(rest).length < MIN_WORDS) return { ok: false, reason: "restates_target" };
  }

  if (VAGUE.some((re) => re.test(t))) return { ok: false, reason: "vague" };

  return { ok: true };
}

/** Strength a proposed edge is allowed to carry, given its failure mode. (03, 15) */
export function admissibleStrength(
  proposed: "hard" | "soft",
  failureMode: string | null | undefined,
  names: { sourceName: string; targetName: string },
): "hard" | "soft" {
  if (proposed === "soft") return "soft";
  return checkFailureMode(failureMode, names).ok ? "hard" : "soft";
}
