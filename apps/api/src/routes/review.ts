import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  applyProposal, findBypassedPrerequisites, findMissingEdgeCandidates,
  findUnobservedFailureModes, proposeNewHardEdge, rejectProposal,
  reverseProposal, reviewQueueByTraversal,
} from "@kg/evidence";
import { prisma } from "../context.js";

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  /** Ordered by how many learners actually cross each edge — most of the graph is never
   *  traversed, and reviewing that is wasted attention. (15) */
  app.get("/api/review/queue", async () => reviewQueueByTraversal(prisma, 100));

  app.get("/api/review/proposals", async () => {
    const proposals = await prisma.promotionProposal.findMany({
      orderBy: [{ status: "asc" }, { effectSize: "desc" }],
      take: 100,
    });
    const ids = [...new Set(proposals.flatMap((p) => [p.srcId, p.dstId].filter(Boolean)))] as string[];
    const concepts = await prisma.concept.findMany({ where: { id: { in: ids } } });
    const name = new Map(concepts.map((c) => [c.id, c.canonicalName]));
    return proposals.map((p) => ({
      id: p.id,
      kind: p.kind,
      status: p.status,
      claim: p.claim,
      src: p.srcId ? (name.get(p.srcId) ?? p.srcId) : null,
      dst: p.dstId ? (name.get(p.dstId) ?? p.dstId) : null,
      distinctLearners: p.distinctLearners,
      effectSize: p.effectSize,
      controlFailureRate: p.controlFailureRate,
      treatmentFailureRate: p.treatmentFailureRate,
      distinctGoals: p.distinctGoals,
    }));
  });

  /** Rescans evidence for edges learners behave as though should exist. */
  app.post("/api/review/scan", async () => {
    const candidates = await findMissingEdgeCandidates(prisma);
    const results = [];
    for (const c of candidates) {
      const r = await proposeNewHardEdge(prisma, c);
      results.push({
        prerequisiteId: c.prerequisiteId,
        targetId: c.targetId,
        spontaneousRequests: c.spontaneousRequests,
        proposed: r.created,
        // A near miss is surfaced rather than silently dropped.
        rejectedFor: r.claim.rejectedFor,
        effectSize: r.claim.effectSize,
      });
    }
    return { scanned: candidates.length, results };
  });

  app.post("/api/review/proposals/:id/accept", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ failureMode: z.string(), reviewedBy: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await applyProposal(prisma, id, body.data.reviewedBy, body.data.failureMode);
    } catch (err) {
      // A rejected failure mode is a validation result, not a server fault.
      return reply.code(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/review/proposals/:id/reject", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { reviewedBy?: string };
    await rejectProposal(prisma, id, body?.reviewedBy ?? "unknown");
    return { ok: true };
  });

  app.post("/api/review/proposals/:id/reverse", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { reason?: string };
    return reverseProposal(prisma, id, body?.reason ?? "reversed from review UI");
  });

  /** Parts of the graph that read as invention rather than observation. (11) */
  app.get("/api/review/negative", async (req) => {
    const q = req.query as { minAttempts?: string };
    const minAttempts = q.minAttempts ? Number(q.minAttempts) : 30;
    const [unobserved, bypassed] = await Promise.all([
      findUnobservedFailureModes(prisma, minAttempts),
      findBypassedPrerequisites(prisma, 10),
    ]);
    return { unobserved, bypassed };
  });
}
