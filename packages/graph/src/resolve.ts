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
  /** Becomes immutable identity if this creates a concept */
  sense: string;
  context?: string | undefined;
  expectedNeighborIds?: string[];
}

export interface ProposeResult {
  conceptId: string;
  outcome: "created" | "bound";
  decision: ResolverDecision;
  candidates: ResolverCandidate[];
  proposalId: string;
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

/** Transaction-scoped, so two sessions reaching the same name bind instead of both inserting */
async function lockOnName(tx: Prisma.TransactionClient, name: string): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, normalizeName(name));
}

/** The only way a Concept enters the graph; adjudicate before opening the transaction */
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

    // Another session may have taken the name before we got the lock
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
    // Prisma cannot type the vector column, so it is set in a separate statement
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
  /** What got written; a `hard` proposal can land as `soft` */
  strength: EdgeStrength;
  demoted: boolean;
  rejected?: "cycle" | "self_loop";
}

/** A `hard` proposal with a weak failure mode is written `soft`, not dropped */
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
