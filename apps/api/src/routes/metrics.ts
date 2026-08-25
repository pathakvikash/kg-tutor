import type { FastifyInstance } from "fastify";
import {
  compareArms, costPerOutcome, crossSessionPersistence,
  graphReuseByTopic, graphReuseRate, wastedTeaching,
} from "@kg/metrics";
import { prisma, providerStatus } from "../context.js";

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/metrics", async () => {
    const [reuse, byTopic, waste, persistence, cost, arms] = await Promise.all([
      graphReuseRate(prisma),
      graphReuseByTopic(prisma),
      wastedTeaching(prisma),
      crossSessionPersistence(prisma),
      costPerOutcome(prisma),
      compareArms(prisma),
    ]);
    const [concepts, edges, hardEdges, learners, evidence, proposals] = await Promise.all([
      prisma.concept.count({ where: { deprecatedAt: null } }),
      prisma.edge.count({ where: { retiredAt: null } }),
      prisma.edge.count({ where: { retiredAt: null, strength: "hard" } }),
      prisma.learner.count(),
      prisma.evidenceEvent.count(),
      prisma.promotionProposal.count({ where: { status: "open" } }),
    ]);

    return {
      providers: providerStatus(),
      graph: { concepts, edges, hardEdges, softEdges: edges - hardEdges },
      counts: { learners, evidence, openProposals: proposals },
      reuse,
      reuseByTopic: byTopic,
      waste,
      persistence,
      cost,
      arms,
    };
  });

  app.get("/api/health", async () => {
    await prisma.$queryRawUnsafe("SELECT 1");
    return { ok: true, ...providerStatus() };
  });
}
