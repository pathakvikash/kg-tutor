import { z } from "zod";
import { evidenceKind, failureDiagnosis, masteryLevel } from "./enums.js";

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
    matchedFailureMode: z.string().nullable(),
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.careless_error),
    itemId: z.string(),
    selfCorrected: z.boolean(),
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.self_reported_skip),
    /** Recorded at low confidence and re-probed later, never believed */
    claimedLevel: masteryLevel,
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.spontaneous_prerequisite_request),
    referencedConceptId: z.string().nullable(),
    question: z.string(),
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.downstream_success),
    viaConceptId: z.string(),
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.reprobe_pass),
    itemId: z.string(),
  }),
  z.object({
    kind: z.literal(evidenceKind.enum.reprobe_fail),
    itemId: z.string(),
    confirms: z.boolean(),
  }),
]);
export type EvidencePayload = z.infer<typeof evidencePayload>;

/** Only evidence a learner actually produced may reach the shared graph */
export function isPoolable(p: EvidencePayload): boolean {
  return p.kind !== "self_reported_skip";
}
