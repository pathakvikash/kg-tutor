import { z } from "zod";

export const edgeType = z.enum([
  "prerequisite_of",
  "contains",
  "related_to",
  "applied_in",
  "extends",
]);
export type EdgeType = z.infer<typeof edgeType>;

export const edgeStrength = z.enum(["hard", "soft"]);
export type EdgeStrength = z.infer<typeof edgeStrength>;

/** Ordinal, never a float; LLM grading cannot justify finer precision */
export const masteryLevel = z.enum(["unknown", "familiar", "functional", "solid"]);
export type MasteryLevel = z.infer<typeof masteryLevel>;

export const evidenceSource = z.enum([
  "self_reported",
  "assessed",
  "taught",
  "inferred",
]);
export type EvidenceSource = z.infer<typeof evidenceSource>;

export const goalDepth = z.enum(["use", "debug", "build"]);
export type GoalDepth = z.infer<typeof goalDepth>;

/** Binary same/different forces partial overlap into a wrong bucket */
export const resolverVerdict = z.enum([
  "same",
  "narrower",
  "broader",
  "related",
  "distinct",
]);
export type ResolverVerdict = z.infer<typeof resolverVerdict>;

export const evidenceKind = z.enum([
  "restated",
  "applied",
  "transferred",
  "failed_check",
  "misconception_shown",
  "careless_error",
  "self_reported_skip",
  "spontaneous_prerequisite_request",
  "downstream_success",
  "reprobe_pass",
  "reprobe_fail",
]);
export type EvidenceKind = z.infer<typeof evidenceKind>;

export const failureDiagnosis = z.enum([
  "misconception",
  "missing_prerequisite",
  "cannot_apply",
  "careless",
]);
export type FailureDiagnosis = z.infer<typeof failureDiagnosis>;

export const chatIntent = z.enum([
  "clarifies_current",
  "prerequisite_gap",
  "tangential",
  "meta",
  "new_goal",
]);
export type ChatIntent = z.infer<typeof chatIntent>;
