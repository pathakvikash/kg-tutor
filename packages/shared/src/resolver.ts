import { z } from "zod";
import { edgeType, resolverVerdict, type EdgeType, type ResolverVerdict } from "./enums.js";

/** Node creation is a proposal, never an insert. (05) */
export const conceptProposal = z.object({
  proposedName: z.string().min(1),
  /** Becomes immutable identity once bound. (05) */
  proposedSense: z.string().min(1),
  context: z.string().optional(),
});
export type ConceptProposal = z.infer<typeof conceptProposal>;

export const resolverCandidate = z.object({
  conceptId: z.string(),
  canonicalName: z.string(),
  sense: z.string(),
  /** Cosine similarity over (name + sense). A candidate generator, never the decision. */
  vectorScore: z.number(),
  lexicalScore: z.number(),
  /** Shared prerequisites and containers — what separates "similar" from "same". (05) */
  neighborhoodOverlap: z.number(),
});
export type ResolverCandidate = z.infer<typeof resolverCandidate>;

export const resolverDecision = z.object({
  verdict: resolverVerdict,
  /** Set for every verdict except `distinct`. */
  relatedConceptId: z.string().nullable(),
  reasoning: z.string(),
});
export type ResolverDecision = z.infer<typeof resolverDecision>;

export interface RelateTo {
  conceptId: string;
  type: EdgeType;
  direction: "from_existing" | "to_existing";
}

/** `alias` is the default for `same` — no destructive op, no id migration. (05) */
export type ResolverAction =
  | { kind: "alias"; targetConceptId: string }
  | { kind: "create"; relateTo: RelateTo | null };

/** Throws when a verdict names no referent; a fallback create would be a blind insert. (05) */
export function actionFor(decision: ResolverDecision): ResolverAction {
  if (decision.verdict === "distinct") return { kind: "create", relateTo: null };

  const conceptId = decision.relatedConceptId;
  if (!conceptId) {
    throw new Error(`resolver verdict "${decision.verdict}" has no relatedConceptId`);
  }

  switch (decision.verdict) {
    case "same":
      return { kind: "alias", targetConceptId: conceptId };
    case "narrower":
      return {
        kind: "create",
        relateTo: { conceptId, type: edgeType.enum.contains, direction: "from_existing" },
      };
    case "broader":
      return {
        kind: "create",
        relateTo: { conceptId, type: edgeType.enum.contains, direction: "to_existing" },
      };
    case "related":
      return {
        kind: "create",
        relateTo: { conceptId, type: edgeType.enum.related_to, direction: "from_existing" },
      };
  }
}

/** `same`, `narrower`, `broader` and `related` all need something to relate to. */
export function isWellFormed(decision: ResolverDecision): boolean {
  return decision.verdict === "distinct" || decision.relatedConceptId !== null;
}

/** Merging is destructive and asymmetric, so the thresholds are biased hard against it. (05) */
export function shouldAutoMerge(c: ResolverCandidate, verdict: ResolverVerdict): boolean {
  return verdict === "same" && c.vectorScore >= 0.95 && c.neighborhoodOverlap >= 0.5;
}
