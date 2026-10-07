import { Prisma } from "@kg/db";
import type { PrismaClient } from "@kg/db";
import {
  DEFAULT_THRESHOLDS,
  contradicts,
  decayedConfidence,
  needsReprobe,
  promote,
  rank,
  type EvidenceKind,
  type EvidenceSource,
  type MasteryLevel,
  type Thresholds,
} from "@kg/shared";

export interface RecordEvidenceInput {
  learnerId: string;
  conceptId: string;
  kind: EvidenceKind;
  sessionId?: string | undefined;
  itemId?: string | undefined;
  contentId?: string | undefined;
  referencedConceptId?: string | undefined;
  response?: string | undefined;
  detail?: Prisma.InputJsonValue | undefined;
  now?: Date;
}

export interface StateChange {
  before: { mastery: MasteryLevel; confidence: number };
  after: { mastery: MasteryLevel; confidence: number };
  demoted: boolean;
  reprobeQueued: boolean;
}

const SOURCE_OF: Record<EvidenceKind, EvidenceSource> = {
  restated: "taught",
  applied: "taught",
  transferred: "taught",
  failed_check: "taught",
  misconception_shown: "taught",
  careless_error: "taught",
  self_reported_skip: "self_reported",
  spontaneous_prerequisite_request: "taught",
  downstream_success: "inferred",
  reprobe_pass: "assessed",
  reprobe_fail: "assessed",
};

const CONFIDENCE_OF: Record<EvidenceSource, number> = {
  self_reported: 0.2,
  inferred: 0.45,
  taught: 0.75,
  assessed: 0.85,
};

export async function recordEvidence(
  prisma: PrismaClient,
  input: RecordEvidenceInput,
  t: Thresholds = DEFAULT_THRESHOLDS,
): Promise<StateChange> {
  const now = input.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    await tx.evidenceEvent.create({
      data: {
        learnerId: input.learnerId,
        conceptId: input.conceptId,
        kind: input.kind,
        sessionId: input.sessionId ?? null,
        itemId: input.itemId ?? null,
        contentId: input.contentId ?? null,
        referencedConceptId: input.referencedConceptId ?? null,
        response: input.response ?? null,
        detail: input.detail ?? Prisma.JsonNull,
        createdAt: now,
      },
    });

    const existing = await tx.learnerConceptState.findUnique({
      where: { learnerId_conceptId: { learnerId: input.learnerId, conceptId: input.conceptId } },
    });

    const beforeMastery: MasteryLevel = existing?.mastery ?? "unknown";
    const beforeConfidence = decayedConfidence(
      existing?.confidence ?? 0,
      existing?.lastEvidenceAt ?? null,
      now,
      t,
    );
    const source = SOURCE_OF[input.kind];

    let mastery = beforeMastery;
    let confidence = beforeConfidence;
    let demoted = false;
    let reprobeQueued = false;

    if (contradicts(input.kind)) {
      const alreadyQueued = existing?.reprobeQueuedAt != null;
      const confirming = input.kind === "reprobe_fail" && alreadyQueued;
      if (confirming && rank(mastery) > 0) {
        const ladder: MasteryLevel[] = ["unknown", "familiar", "functional", "solid"];
        mastery = ladder[rank(mastery) - 1]!;
        demoted = true;
      }
      confidence = Math.min(confidence, 0.25);
      reprobeQueued = true;
    } else {
      const proposed = promote(beforeMastery, input.kind);
      // A self-report may set a level but must never look well-evidenced
      const evidenceConfidence = CONFIDENCE_OF[source];
      mastery = proposed;
      confidence =
        rank(proposed) > rank(beforeMastery)
          ? evidenceConfidence
          : Math.max(confidence, evidenceConfidence * 0.9);
    }

    const after = await tx.learnerConceptState.upsert({
      where: { learnerId_conceptId: { learnerId: input.learnerId, conceptId: input.conceptId } },
      create: {
        learnerId: input.learnerId,
        conceptId: input.conceptId,
        mastery,
        confidence,
        source,
        lastEvidenceAt: now,
        reprobeQueuedAt: reprobeQueued ? now : null,
      },
      update: {
        mastery,
        confidence,
        source,
        lastEvidenceAt: now,
        reprobeQueuedAt: reprobeQueued ? now : null,
      },
    });

    return {
      before: { mastery: beforeMastery, confidence: beforeConfidence },
      after: { mastery: after.mastery, confidence: after.confidence },
      demoted,
      reprobeQueued,
    };
  });
}

/** Backwards only, at lower confidence, and never overwriting direct evidence */
export async function propagateBackwards(
  prisma: PrismaClient,
  learnerId: string,
  conceptId: string,
  now = new Date(),
): Promise<string[]> {
  const prereqs = await prisma.edge.findMany({
    where: { dstId: conceptId, type: "prerequisite_of", strength: "hard", retiredAt: null },
  });

  const touched: string[] = [];
  for (const e of prereqs) {
    const existing = await prisma.learnerConceptState.findUnique({
      where: { learnerId_conceptId: { learnerId, conceptId: e.srcId } },
    });
    if (existing && existing.source !== "inferred" && rank(existing.mastery) >= rank("functional")) {
      continue;
    }
    await recordEvidence(prisma, {
      learnerId,
      conceptId: e.srcId,
      kind: "downstream_success",
      referencedConceptId: conceptId,
      now,
    });
    touched.push(e.srcId);
  }
  return touched;
}

export async function conceptsNeedingReprobe(
  prisma: PrismaClient,
  learnerId: string,
  now = new Date(),
  t: Thresholds = DEFAULT_THRESHOLDS,
): Promise<{ conceptId: string; mastery: MasteryLevel; confidence: number }[]> {
  const rows = await prisma.learnerConceptState.findMany({ where: { learnerId } });
  return rows
    .map((r) => ({
      conceptId: r.conceptId,
      mastery: r.mastery,
      confidence: decayedConfidence(r.confidence, r.lastEvidenceAt, now, t),
    }))
    .filter((r) => needsReprobe(r.mastery, r.confidence, t))
    .sort((a, b) => a.confidence - b.confidence);
}
