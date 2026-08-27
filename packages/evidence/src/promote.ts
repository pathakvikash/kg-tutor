import { Prisma } from "@kg/db";
import type { PrismaClient } from "@kg/db";
import { DEFAULT_THRESHOLDS, checkFailureMode, type Thresholds } from "@kg/shared";
import { evaluateClaim, type ControlledClaim } from "./control.js";

/** Tiered by blast radius: `auto` is local and self-correcting, `review` needs a human. (11) */
export type PromotionTier = "auto" | "review";

export function tierFor(kind: string): PromotionTier {
  switch (kind) {
    case "item_stats":
    case "edge_confidence":
      return "auto";
    default:
      return "review";
  }
}

export interface MissingEdgeCandidate {
  prerequisiteId: string;
  targetId: string;
  /** Learners who spontaneously asked about the prerequisite while attempting the target. */
  spontaneousRequests: number;
  /** Misconceptions at the target that name the prerequisite's territory. */
  misconceptions: number;
}

/** Finds absent edges learners behave as though exist; a spontaneous request has no selection confound. (19) */
export async function findMissingEdgeCandidates(
  prisma: PrismaClient,
): Promise<MissingEdgeCandidate[]> {
  const rows = await prisma.$queryRawUnsafe<
    { prerequisiteId: string; targetId: string; requests: bigint }[]
  >(`
    SELECT e."referencedConceptId" AS "prerequisiteId",
           e."conceptId"           AS "targetId",
           COUNT(DISTINCT e."learnerId") AS requests
      FROM "EvidenceEvent" e
     WHERE e.kind = 'spontaneous_prerequisite_request'
       AND e."referencedConceptId" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "Edge" g
          WHERE g."srcId" = e."referencedConceptId"
            AND g."dstId" = e."conceptId"
            AND g.type = 'prerequisite_of'
            AND g."retiredAt" IS NULL
       )
     GROUP BY 1, 2
     ORDER BY requests DESC
  `);

  const out: MissingEdgeCandidate[] = [];
  for (const r of rows) {
    const misconceptions = await prisma.misconception.count({
      where: { conceptId: r.targetId, matchedFailureMode: null },
    });
    out.push({
      prerequisiteId: r.prerequisiteId,
      targetId: r.targetId,
      spontaneousRequests: Number(r.requests),
      misconceptions,
    });
  }
  return out;
}

export interface ProposalResult {
  proposalId: string | null;
  claim: ControlledClaim;
  created: boolean;
}

/** Writes a proposal with its evidence packet, never an edge; structural changes are proposals. (11) */
export async function proposeNewHardEdge(
  prisma: PrismaClient,
  candidate: MissingEdgeCandidate,
  t: Thresholds = DEFAULT_THRESHOLDS,
): Promise<ProposalResult> {
  const claim = await evaluateClaim(prisma, candidate.prerequisiteId, candidate.targetId, t);
  if (!claim.passes) return { proposalId: null, claim, created: false };

  const existing = await prisma.promotionProposal.findFirst({
    where: {
      kind: "new_hard_edge",
      srcId: candidate.prerequisiteId,
      dstId: candidate.targetId,
      status: "open",
    },
  });
  if (existing) {
    await prisma.promotionProposal.update({
      where: { id: existing.id },
      data: {
        distinctLearners: claim.distinctLearners,
        effectSize: claim.effectSize,
        controlFailureRate: claim.controlFailureRate,
        treatmentFailureRate: claim.treatmentFailureRate,
        distinctGoals: claim.distinctGoals,
        evidencePacket: { ...claim, candidate } as unknown as Prisma.InputJsonValue,
      },
    });
    return { proposalId: existing.id, claim, created: false };
  }

  const [src, dst] = await Promise.all([
    prisma.concept.findUniqueOrThrow({ where: { id: candidate.prerequisiteId } }),
    prisma.concept.findUniqueOrThrow({ where: { id: candidate.targetId } }),
  ]);

  const proposal = await prisma.promotionProposal.create({
    data: {
      kind: "new_hard_edge",
      srcId: candidate.prerequisiteId,
      dstId: candidate.targetId,
      claim:
        `${claim.distinctLearners} learners attempted "${dst.canonicalName}". ` +
        `Those without "${src.canonicalName}" failed ${(claim.treatmentFailureRate * 100).toFixed(0)}% ` +
        `of the time; those with it failed ${(claim.controlFailureRate * 100).toFixed(0)}%. ` +
        `${candidate.spontaneousRequests} asked about it unprompted.`,
      distinctLearners: claim.distinctLearners,
      effectSize: claim.effectSize,
      controlFailureRate: claim.controlFailureRate,
      treatmentFailureRate: claim.treatmentFailureRate,
      distinctGoals: claim.distinctGoals,
      evidencePacket: { ...claim, candidate } as unknown as Prisma.InputJsonValue,
    },
  });
  return { proposalId: proposal.id, claim, created: true };
}

/** Promoted edges stay `provisional` and keep their packet, so reversal stays routine. (11) */
export async function applyProposal(
  prisma: PrismaClient,
  proposalId: string,
  reviewedBy: string,
  failureMode: string,
): Promise<{ edgeId: string }> {
  const p = await prisma.promotionProposal.findUniqueOrThrow({ where: { id: proposalId } });
  if (p.status !== "open") throw new Error(`proposal ${proposalId} is already ${p.status}`);
  if (!p.srcId || !p.dstId) throw new Error("proposal has no src/dst");

  const [src, dst] = await Promise.all([
    prisma.concept.findUnique({ where: { id: p.srcId } }),
    prisma.concept.findUnique({ where: { id: p.dstId } }),
  ]);
  // Both ends must still be live; an open proposal can outlive the concepts it names.
  const dead = [
    !src ? "the source concept no longer exists" : null,
    !dst ? "the target concept no longer exists" : null,
    src?.deprecatedAt ? `the source concept "${src.canonicalName}" has been deprecated` : null,
    dst?.deprecatedAt ? `the target concept "${dst.canonicalName}" has been deprecated` : null,
  ].filter(Boolean);
  if (dead.length > 0 || !src || !dst) {
    throw new Error(
      `this proposal can no longer be accepted: ${dead.join("; ")}. ` +
        `Reject it — the graph has moved on since it was raised.`,
    );
  }
  const check = checkFailureMode(failureMode, {
    sourceName: src.canonicalName,
    targetName: dst.canonicalName,
  });
  if (!check.ok) {
    throw new Error(`failure mode rejected (${check.reason}); a hard edge requires a real one`);
  }

  return prisma.$transaction(async (tx) => {
    const edge = await tx.edge.create({
      data: {
        srcId: p.srcId!,
        dstId: p.dstId!,
        type: "prerequisite_of",
        strength: "hard",
        failureMode,
        provisional: true,
        promotedById: p.id,
        confidence: Math.min(0.9, 0.5 + p.effectSize),
      },
    });
    await tx.promotionProposal.update({
      where: { id: p.id },
      data: { status: "accepted", reviewedBy, reviewedAt: new Date() },
    });
    return { edgeId: edge.id };
  });
}

export async function rejectProposal(
  prisma: PrismaClient,
  proposalId: string,
  reviewedBy: string,
): Promise<void> {
  await prisma.promotionProposal.update({
    where: { id: proposalId },
    data: { status: "rejected", reviewedBy, reviewedAt: new Date() },
  });
}

/** Reversal is routine, not an incident. The edge is retired, never deleted. (11) */
export async function reverseProposal(
  prisma: PrismaClient,
  proposalId: string,
  reason: string,
): Promise<{ retired: number }> {
  const result = await prisma.edge.updateMany({
    where: { promotedById: proposalId, retiredAt: null },
    data: { retiredAt: new Date(), retiredReason: reason },
  });
  await prisma.promotionProposal.update({
    where: { id: proposalId },
    data: { status: "rejected" },
  });
  return { retired: result.count };
}
