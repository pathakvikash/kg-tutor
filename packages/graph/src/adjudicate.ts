import { resolverVerdict, type ResolverCandidate, type ResolverDecision } from "@kg/shared";
import { z } from "zod";

export interface AdjudicationInput {
  proposedName: string;
  proposedSense: string;
  context?: string | undefined;
  candidates: ResolverCandidate[];
}

export interface Adjudicator {
  readonly name: string;
  adjudicate(input: AdjudicationInput): Promise<ResolverDecision>;
}

const rawDecision = z.object({
  verdict: resolverVerdict,
  relatedConceptId: z.string().nullable(),
  reasoning: z.string(),
});

/** An id that was never offered is downgraded to `distinct` rather than trusted. (05) */
export function validateDecision(
  raw: unknown,
  candidates: ResolverCandidate[],
): { decision: ResolverDecision; downgraded: boolean } {
  const parsed = rawDecision.parse(raw);
  if (parsed.verdict === "distinct") {
    return { decision: { ...parsed, relatedConceptId: null }, downgraded: false };
  }
  const known = new Set(candidates.map((c) => c.conceptId));
  if (!parsed.relatedConceptId || !known.has(parsed.relatedConceptId)) {
    return {
      decision: {
        verdict: "distinct",
        relatedConceptId: null,
        reasoning:
          `adjudicator returned unknown id ${JSON.stringify(parsed.relatedConceptId)} ` +
          `for verdict "${parsed.verdict}"; downgraded to distinct. ` +
          `original reasoning: ${parsed.reasoning}`,
      },
      downgraded: true,
    };
  }
  return { decision: parsed, downgraded: false };
}

export const ADJUDICATION_SYSTEM_PROMPT = `You decide whether a proposed learning concept already exists in a shared knowledge graph.

You are given a proposed concept (a name and a one-line sense) and a list of existing
candidates. Return exactly one verdict:

- "same": the candidate means the same thing. Different wording is fine; the *meaning*
  must match. Two concepts a learner could master independently are NOT the same.
- "narrower": the proposal is a proper part of the candidate (Flexbox vs CSS layout).
- "broader": the candidate is a proper part of the proposal.
- "related": genuinely connected but neither contains the other.
- "distinct": no meaningful relationship to any candidate.

Rules:
- relatedConceptId MUST be one of the candidate ids given, or null when verdict is "distinct".
- Prefer "narrower"/"broader" over "same" whenever one is a part of the other. Most
  apparent duplicates are subsumption, not identity.
- Prefer "distinct" when unsure. Two concepts wrongly merged corrupt every learner
  attached to either; two duplicates are repairable later.
- Names that collide across domains are NOT the same concept ("Model" in machine
  learning vs "Model" in MVC).

Respond with JSON: {"verdict": ..., "relatedConceptId": ..., "reasoning": "one sentence"}`;

export function buildAdjudicationPrompt(input: AdjudicationInput): string {
  const lines = [
    `Proposed concept:`,
    `  name: ${input.proposedName}`,
    `  sense: ${input.proposedSense}`,
  ];
  if (input.context) lines.push(`  discovered while: ${input.context}`);
  lines.push("", "Candidates:");
  if (input.candidates.length === 0) {
    lines.push("  (none)");
  }
  for (const c of input.candidates) {
    lines.push(
      `  - id: ${c.conceptId}`,
      `    name: ${c.canonicalName}`,
      `    sense: ${c.sense}`,
      `    similarity: vector ${c.vectorScore.toFixed(2)}, ` +
        `lexical ${c.lexicalScore.toFixed(2)}, ` +
        `shared neighbours ${c.neighborhoodOverlap.toFixed(2)}`,
    );
  }
  return lines.join("\n");
}

/** No candidates means nothing to compare against, so no model call is warranted. (17) */
export function trivialDecision(input: AdjudicationInput): ResolverDecision | null {
  if (input.candidates.length === 0) {
    return { verdict: "distinct", relatedConceptId: null, reasoning: "no candidates found" };
  }
  return null;
}
