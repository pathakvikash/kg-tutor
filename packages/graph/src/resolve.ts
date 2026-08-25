import type { PrismaClient, Prisma } from "@kg/db";
import {
  actionFor,
  admissibleStrength,
  type EdgeStrength,
  type EdgeType,
  type ResolverCandidate,
  type ResolverDecision,
} from "@kg/shared";
import { findCandidates } from "./candidates.js";
import { identityText, toVectorLiteral, type EmbeddingProvider } from "./embedding.js";
import { trivialDecision, type Adjudicator } from "./adjudicate.js";

export interface ProposeInput {
  name: string;
  /** Becomes immutable identity if this creates a concept. (05) */
  sense: string;
  context?: string | undefined;
  /** Concepts this was discovered next to; drives the graph-local retrieval arm. */
  expectedNeighborIds?: string[];
}

export interface ProposeResult {
  conceptId: string;
  /** `bound` = an alias was attached to an existing concept; nothing was created. */
  outcome: "created" | "bound";
  decision: ResolverDecision;
  candidates: ResolverCandidate[];
  proposalId: string;
  /** Edge written alongside a create, when the verdict implied subsumption. */
  edgeId?: string;
}

export interface ResolverDeps {
  prisma: PrismaClient;
  embedding: EmbeddingProvider;
  adjudicator: Adjudicator;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Two sessions expanding adjacent topics will both reach `Python` within seconds of
 * each other. Serializing on the normalized name means the second one sees the first
 * one's concept and binds to it, instead of both inserting.
 *
 * `hashtext` is stable within a major version, and the lock is transaction-scoped so
 * it releases on commit or rollback without any cleanup path.
 */
async function lockOnName(tx: Prisma.TransactionClient, name: string): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, normalizeName(name));
}

/**
 * The only legitimate way a Concept enters the graph. (05)
 *
 * Everything is one transaction: the advisory lock, the exact-name recheck, the
 * candidate query, the write, and the proposal record. A crash mid-way leaves no
 * half-resolved concept and no orphan alias.
 *
 * The adjudicator call happens *before* the transaction opens — it is a network call
 * and must not hold a lock. The recheck inside the transaction is what makes that safe.
 */
export async function proposeConcept(
  deps: ResolverDeps,
  input: ProposeInput,
): Promise<ProposeResult> {
  const { prisma, embedding, adjudicator } = deps;
  const expected = input.expectedNeighborIds ?? [];

  const [vector] = await embedding.embed([identityText(input.name, input.sense)]);
  if (!vector) throw new Error("embedding provider returned no vector");

  const candidates = await findCandidates(prisma, {
    name: input.name,
    senseVector: vector,
    expectedNeighborIds: expected,
  });

  const decision =
    trivialDecision({
      proposedName: input.name,
      proposedSense: input.sense,
      context: input.context,
      candidates,
    }) ??
    (await adjudicator.adjudicate({
      proposedName: input.name,
      proposedSense: input.sense,
      context: input.context,
      candidates,
    }));

  const action = actionFor(decision);

  return prisma.$transaction(async (tx) => {
    await lockOnName(tx, input.name);

    const proposal = await tx.conceptProposal.create({
      data: {
        proposedName: input.name,
        proposedSense: input.sense,
        context: input.context ?? null,
        expectedNeighborIds: expected,
        verdict: decision.verdict,
        candidates: candidates as unknown as Prisma.InputJsonValue,
        resolvedAt: new Date(),
      },
    });

    // Cheap exact-name recheck under the lock. Whoever got here first may have created
    // or aliased this name while we were out at the adjudicator.
    const existing = await tx.conceptAlias.findUnique({
      where: { name: normalizeName(input.name) },
    });
    if (existing) {
      await tx.conceptProposal.update({
        where: { id: proposal.id },
        data: { resolvedToId: existing.conceptId, outcome: "bound" },
      });
      return {
        conceptId: existing.conceptId,
        outcome: "bound" as const,
        decision: {
          ...decision,
          reasoning: `bound to an existing alias created concurrently; ${decision.reasoning}`,
        },
        candidates,
        proposalId: proposal.id,
      };
    }

    if (action.kind === "alias") {
      await tx.conceptAlias.create({
        data: { conceptId: action.targetConceptId, name: normalizeName(input.name) },
      });
      await tx.conceptProposal.update({
        where: { id: proposal.id },
        data: { resolvedToId: action.targetConceptId, outcome: "bound" },
      });
      return {
        conceptId: action.targetConceptId,
        outcome: "bound" as const,
        decision,
        candidates,
        proposalId: proposal.id,
      };
    }

    const concept = await tx.concept.create({
      data: { canonicalName: input.name.trim(), sense: input.sense.trim() },
    });
    // Prisma cannot type the vector column, so the identity vector is set separately —
    // still inside the same transaction.
    await tx.$executeRawUnsafe(
      `UPDATE "Concept" SET "senseVector" = $1::vector WHERE id = $2`,
      toVectorLiteral(vector),
      concept.id,
    );
    await tx.conceptAlias.create({
      data: { conceptId: concept.id, name: normalizeName(input.name) },
    });

    let edgeId: string | undefined;
    if (action.relateTo) {
      const { conceptId: other, type, direction } = action.relateTo;
      const [srcId, dstId] =
        direction === "from_existing" ? [other, concept.id] : [concept.id, other];
      const edge = await tx.edge.create({
        data: { srcId, dstId, type, strength: "soft" },
      });
      edgeId = edge.id;
    }

    await tx.conceptProposal.update({
      where: { id: proposal.id },
      data: { resolvedToId: concept.id, outcome: "created" },
    });

    return {
      conceptId: concept.id,
      outcome: "created" as const,
      decision,
      candidates,
      proposalId: proposal.id,
      ...(edgeId ? { edgeId } : {}),
    };
  });
}

export interface ProposeEdgeInput {
  srcId: string;
  dstId: string;
  type: EdgeType;
  strength: EdgeStrength;
  failureMode?: string | null;
  confidence?: number;
}

export interface ProposeEdgeResult {
  edgeId: string | null;
  /** What actually got written — a `hard` proposal can land as `soft`. (03, 15) */
  strength: EdgeStrength;
  demoted: boolean;
  rejected?: "cycle" | "self_loop";
}

/**
 * Edges go through the same discipline as nodes. A `hard` proposal whose failure mode
 * is vague, circular or a restatement is written as `soft` rather than dropped — the
 * dependency may well be real even when the justification is empty. (03, 15)
 *
 * A cycle is not an error to swallow: the database rejects it, and the fact that a
 * model proposed one is itself a signal that the two concepts are tightly coupled. (13)
 */
export async function proposeEdge(
  prisma: PrismaClient,
  input: ProposeEdgeInput,
): Promise<ProposeEdgeResult> {
  const [src, dst] = await Promise.all([
    prisma.concept.findUniqueOrThrow({ where: { id: input.srcId } }),
    prisma.concept.findUniqueOrThrow({ where: { id: input.dstId } }),
  ]);

  const strength = admissibleStrength(input.strength, input.failureMode, {
    sourceName: src.canonicalName,
    targetName: dst.canonicalName,
  });
  const demoted = strength !== input.strength;

  try {
    const edge = await prisma.edge.upsert({
      where: {
        srcId_dstId_type: { srcId: input.srcId, dstId: input.dstId, type: input.type },
      },
      create: {
        srcId: input.srcId,
        dstId: input.dstId,
        type: input.type,
        strength,
        failureMode: strength === "hard" ? (input.failureMode ?? null) : null,
        confidence: input.confidence ?? 0.5,
      },
      update: {},
    });
    return { edgeId: edge.id, strength, demoted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("self-loop")) {
      return { edgeId: null, strength, demoted, rejected: "self_loop" };
    }
    if (message.includes("prerequisite cycle")) {
      return { edgeId: null, strength, demoted, rejected: "cycle" };
    }
    throw err;
  }
}
