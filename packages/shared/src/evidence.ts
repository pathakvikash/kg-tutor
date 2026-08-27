import { z } from "zod";
import { evidenceKind, failureDiagnosis, masteryLevel } from "./enums.js";

/** Every concept attempt must emit one of these, or the learner model drifts. (10) */
export const evidencePayload = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(evidenceKind.enum.restated),
    response: z.string(),
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.applied),
    itemId: z.string(),
    response: z.string(),
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.transferred),
    itemId: z.string(),
    response: z.string(),
    /** True when the item's context was absent from the explanation shown. (16) */
    novelContext: z.boolean(),
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.failed_check),
    itemId: z.string(),
    response: z.string(),
    diagnosis: failureDiagnosis,
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.misconception_shown),
    belief: z.string(),
    /** Set when the response matched a stored failure mode — supports that edge. (11) */
    matchedFailureMode: z.string().nullable(),
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.careless_error),
    itemId: z.string(),
    selfCorrected: z.boolean(),
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.self_reported_skip),
    /** Honoured, never believed — recorded low-confidence and re-probed later. (10) */
    claimedLevel: masteryLevel,
  }),
  z.object({
    /** The learner named their own gap, so this carries no selection confound. (19) */
    kind: z.literal(evidenceKind.enum.spontaneous_prerequisite_request),
    referencedConceptId: z.string().nullable(),
    question: z.string(),
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.downstream_success),
    /** The concept whose clean acquisition demonstrates this prerequisite. (10) */
    viaConceptId: z.string(),
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.reprobe_pass),
    itemId: z.string(),
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.reprobe_fail),
    itemId: z.string(),
    /** A second consecutive failure is what permits demotion. (10) */
    confirms: z.boolean(),
  }),
]);
export type EvidencePayload = z.infer<typeof evidencePayload>;

/** Only evidence a learner actually produced may reach the shared graph. (policy D) */
export function isPoolable(p: EvidencePayload): boolean {
  return p.kind !== "self_reported_skip";
}
