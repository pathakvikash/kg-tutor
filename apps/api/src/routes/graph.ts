import type { FastifyInstance } from "fastify";
import { prisma } from "../context.js";

export async function graphRoutes(app: FastifyInstance): Promise<void> {
  /** The whole graph, shaped for a layered DAG view. */
  app.get("/api/graph", async (req) => {
    const q = req.query as { topicId?: string; learnerId?: string };

    const conceptWhere = q.topicId
      ? { deprecatedAt: null, topics: { some: { topicId: q.topicId } } }
      : { deprecatedAt: null };

    const [concepts, topics] = await Promise.all([
      prisma.concept.findMany({
        where: conceptWhere,
        include: { aliases: true, topics: { include: { topic: true } } },
        orderBy: { canonicalName: "asc" },
      }),
      prisma.topic.findMany({ orderBy: { name: "asc" } }),
    ]);

    const ids = concepts.map((c) => c.id);
    const edges = await prisma.edge.findMany({
      where: { retiredAt: null, srcId: { in: ids }, dstId: { in: ids } },
    });

    const mastery = q.learnerId
      ? new Map(
          (await prisma.learnerConceptState.findMany({ where: { learnerId: q.learnerId } })).map(
            (s) => [s.conceptId, { mastery: s.mastery, confidence: s.confidence, source: s.source }],
          ),
        )
      : new Map();

    return {
      topics: topics.map((t) => ({ id: t.id, name: t.name, kind: t.kind })),
      nodes: concepts.map((c) => ({
        id: c.id,
        name: c.canonicalName,
        sense: c.sense,
        aliases: c.aliases.map((a) => a.name),
        topics: c.topics.map((t) => ({ id: t.topicId, name: t.topic.name, direct: t.direct })),
        state: mastery.get(c.id) ?? null,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.srcId,
        target: e.dstId,
        type: e.type,
        strength: e.strength,
        failureMode: e.failureMode,
        confidence: e.confidence,
        provisional: e.provisional,
      })),
    };
  });

  app.get("/api/concepts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = await prisma.concept.findUnique({
      where: { id },
      include: {
        aliases: true,
        topics: { include: { topic: true } },
        items: { where: { status: { not: "retired" } } },
        outgoing: { include: { dst: true } },
        incoming: { include: { src: true } },
      },
    });
    if (!c) return reply.code(404).send({ error: "concept not found" });
    return c;
  });

  /** A cheap stamp the UI polls, so a full graph fetch only happens on real change. */
  app.get("/api/graph/version", async () => {
    const [rows] = await prisma.$queryRawUnsafe<
      { concepts: bigint; edges: bigint; latest: Date | null }[]
    >(`
      SELECT (SELECT COUNT(*) FROM "Concept" WHERE "deprecatedAt" IS NULL) AS concepts,
             (SELECT COUNT(*) FROM "Edge" WHERE "retiredAt" IS NULL) AS edges,
             GREATEST(
               (SELECT MAX("updatedAt") FROM "Concept"),
               (SELECT MAX("updatedAt") FROM "Edge"),
               (SELECT MAX("updatedAt") FROM "LearnerConceptState")
             ) AS latest
    `);
    return {
      concepts: Number(rows?.concepts ?? 0),
      edges: Number(rows?.edges ?? 0),
      stamp: `${rows?.concepts}-${rows?.edges}-${rows?.latest?.toISOString() ?? ""}`,
    };
  });

  app.get("/api/topics", async () => {
    const topics = await prisma.topic.findMany({
      include: { _count: { select: { concepts: true, milestones: true } } },
      orderBy: { name: "asc" },
    });
    return topics.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      description: t.description,
      concepts: t._count.concepts,
      milestones: t._count.milestones,
    }));
  });
}
