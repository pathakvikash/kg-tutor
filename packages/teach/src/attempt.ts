import type { PrismaClient } from "@kg/db";
import {
  DEFAULT_THRESHOLDS,
  type EvidenceKind,
  type FailureDiagnosis,
  type MasteryLevel,
  type Thresholds,
} from "@kg/shared";
import type { LLMProvider } from "@kg/llm";
import { gradeResponse, type GradeResult } from "./grade.js";
import { resolveMisconceptions } from "./due.js";
import { propagateBackwards, recordEvidence, type StateChange } from "./state.js";

export type AttemptAction =
  | { kind: "correct_misconception"; belief: string; edgeId: string | null }
  | { kind: "detour"; prerequisiteConceptId: string; prerequisiteName: string }
  | { kind: "reexplain"; attemptsUsed: number }
  | { kind: "reask" }
  | { kind: "advance" }
  | { kind: "block"; reason: string };

export interface AttemptContext {
  learnerId: string;
  conceptId: string;
  sessionId?: string | undefined;
  itemId?: string | undefined;
  /** Bounded per decision 10, carried across turns within one concept. */
  reexplanationsUsed: number;
  detoursUsedInChain: number;
  detourDepth: number;
}

export interface AttemptOutcome {
  grade: GradeResult;
  action: AttemptAction;
  evidenceKind: EvidenceKind;
  state: StateChange;
  propagatedTo: string[];
  /** Recorded beliefs this answer cleared. Worth telling the learner about. */
  misconceptionsResolved: number;
}

/** Claim `transferred` only when the item required transfer and the answer was not a restatement. (10, 16) */
function evidenceFor(grade: GradeResult, requiresTransfer: boolean): EvidenceKind {
  if (!grade.correct) {
    if (grade.diagnosis === "careless") return "careless_error";
    if (grade.diagnosis === "misconception") return "misconception_shown";
    return "failed_check";
  }
  if (grade.restatementOnly) return "restated";
  return requiresTransfer ? "transferred" : "applied";
}

/** The four failure causes need opposite responses; the bounds stop an infinite descent. (10) */
export function decideAction(
  grade: GradeResult,
  ctx: AttemptContext,
  prerequisite: { conceptId: string; name: string } | null,
  t: Thresholds = DEFAULT_THRESHOLDS,
): AttemptAction {
  if (grade.correct) return { kind: "advance" };

  const diagnosis: FailureDiagnosis = grade.diagnosis;

  if (diagnosis === "careless") return { kind: "reask" };

  if (diagnosis === "misconception") {
    return { kind: "correct_misconception", belief: grade.belief ?? "", edgeId: grade.matchedEdgeId };
  }

  if (diagnosis === "missing_prerequisite") {
    if (!prerequisite) {
      // Nothing concrete to descend into; treat it as an explanation problem instead.
      return ctx.reexplanationsUsed < t.maxReexplanations
        ? { kind: "reexplain", attemptsUsed: ctx.reexplanationsUsed + 1 }
        : { kind: "block", reason: "prerequisite gap with no identified prerequisite" };
    }
    if (ctx.detourDepth >= t.maxDetourDepth) {
      return { kind: "block", reason: `detour depth ${ctx.detourDepth} reached` };
    }
    if (ctx.detoursUsedInChain >= t.maxDetoursPerChain) {
      return { kind: "block", reason: "detour budget for this chain is spent this session" };
    }
    return {
      kind: "detour",
      prerequisiteConceptId: prerequisite.conceptId,
      prerequisiteName: prerequisite.name,
    };
  }

  // cannot_apply
  return ctx.reexplanationsUsed < t.maxReexplanations
    ? { kind: "reexplain", attemptsUsed: ctx.reexplanationsUsed + 1 }
    : { kind: "block", reason: "re-explanation budget spent" };
}

export interface RunAttemptInput {
  prisma: PrismaClient;
  llm: LLMProvider;
  ctx: AttemptContext;
  prompt: string;
  /** The snippet the prompt refers to, when the item has one. */
  code?: string | null;
  codeLanguage?: string | null;
  response: string;
  requiresTransfer: boolean;
  thresholds?: Thresholds;
}

/** One graded turn; every path must emit exactly one evidence event or the model goes stale. (10) */
export async function runAttempt(input: RunAttemptInput): Promise<AttemptOutcome> {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const { prisma, ctx } = input;

  const concept = await prisma.concept.findUniqueOrThrow({ where: { id: ctx.conceptId } });
  const prereqEdges = await prisma.edge.findMany({
    where: { dstId: ctx.conceptId, type: "prerequisite_of", strength: "hard", retiredAt: null },
    include: { src: true },
  });

  const grade = await gradeResponse(input.llm, {
    prompt: input.prompt,
    code: input.code ?? null,
    codeLanguage: input.codeLanguage ?? null,
    response: input.response,
    conceptName: concept.canonicalName,
    requiresTransfer: input.requiresTransfer,
    failureModes: prereqEdges
      .filter((e) => e.failureMode)
      .map((e) => ({
        edgeId: e.id,
        prerequisiteName: e.src.canonicalName,
        failureMode: e.failureMode!,
      })),
  });

  const matchedEdge = grade.matchedEdgeId
    ? prereqEdges.find((e) => e.id === grade.matchedEdgeId)
    : undefined;
  const prerequisite = matchedEdge
    ? { conceptId: matchedEdge.srcId, name: matchedEdge.src.canonicalName }
    : (prereqEdges[0]
        ? { conceptId: prereqEdges[0].srcId, name: prereqEdges[0].src.canonicalName }
        : null);

  const action = decideAction(grade, ctx, prerequisite, t);
  const evidenceKind = evidenceFor(grade, input.requiresTransfer);

  const state = await recordEvidence(
    prisma,
    {
      learnerId: ctx.learnerId,
      conceptId: ctx.conceptId,
      kind: evidenceKind,
      sessionId: ctx.sessionId,
      itemId: ctx.itemId,
      response: input.response,
      detail: { diagnosis: grade.diagnosis, action: action.kind, reasoning: grade.reasoning },
    },
    t,
  );

  if (grade.belief && evidenceKind === "misconception_shown") {
    // Same belief twice is a stronger signal, and the review queue orders by the count.
    const open = await prisma.misconception.findFirst({
      where: { learnerId: ctx.learnerId, conceptId: ctx.conceptId, resolvedAt: null },
    });
    if (open) {
      await prisma.misconception.update({
        where: { id: open.id },
        data: {
          observedCount: { increment: 1 },
          belief: grade.belief,
          matchedFailureMode: matchedEdge?.failureMode ?? open.matchedFailureMode,
        },
      });
    } else {
      await prisma.misconception.create({
        data: {
          learnerId: ctx.learnerId,
          conceptId: ctx.conceptId,
          belief: grade.belief,
          matchedFailureMode: matchedEdge?.failureMode ?? null,
        },
      });
    }
  }

  // Only a demonstration clears the belief; a restatement does not count. (10, 16)
  const misconceptionsResolved =
    grade.correct && !grade.restatementOnly
      ? await resolveMisconceptions(prisma, ctx.learnerId, ctx.conceptId)
      : 0;

  // Clean acquisition is the strongest evidence about the prerequisites, and it is free. (10)
  const propagatedTo =
    grade.correct && !grade.restatementOnly
      ? await propagateBackwards(prisma, ctx.learnerId, ctx.conceptId)
      : [];

  if (ctx.itemId) {
    await prisma.assessmentItem.update({
      where: { id: ctx.itemId },
      data: {
        timesUsed: { increment: 1 },
        ...(grade.correct ? { correctCount: { increment: 1 } } : {}),
      },
    });
  }

  return { grade, action, evidenceKind, state, propagatedTo, misconceptionsResolved };
}

/** Concepts blocked by a spent detour budget, to revisit in a later session. (10) */
export async function blockConcept(
  prisma: PrismaClient,
  learnerId: string,
  conceptId: string,
  until: Date,
): Promise<void> {
  await prisma.learnerConceptState.upsert({
    where: { learnerId_conceptId: { learnerId, conceptId } },
    create: { learnerId, conceptId, blockedUntil: until, mastery: "unknown" as MasteryLevel },
    update: { blockedUntil: until },
  });
}
