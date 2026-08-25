import type { PrismaClient } from "@kg/db";

export interface FictionCandidate {
  edgeId: string;
  srcName: string;
  dstName: string;
  failureMode: string;
  /** Learner attempts at the target since this edge was written. */
  attempts: number;
  /** How many exhibited the failure mode this edge claims. */
  observed: number;
}

/**
 * Negative evidence: parts of the graph that look like invention. (11)
 *
 * A stored failure mode that no learner has ever exhibited across hundreds of attempts
 * is probably fiction — something plausible a model wrote. Given the whole graph starts
 * as model assertion, this is arguably the highest-value evidence type in year one,
 * because it *prunes* claims rather than adding more.
 *
 * A candidate is a prompt to look, not a verdict. Some real failure modes are rare.
 */
export async function findUnobservedFailureModes(
  prisma: PrismaClient,
  minAttempts = 30,
): Promise<FictionCandidate[]> {
  const edges = await prisma.edge.findMany({
    where: { strength: "hard", failureMode: { not: null }, retiredAt: null },
    include: { src: true, dst: true },
  });

  const out: FictionCandidate[] = [];
  for (const e of edges) {
    const attempts = await prisma.evidenceEvent.count({
      where: {
        conceptId: e.dstId,
        kind: { in: ["applied", "transferred", "failed_check", "misconception_shown"] },
        createdAt: { gte: e.createdAt },
      },
    });
    if (attempts < minAttempts) continue;

    const observed = await prisma.misconception.count({
      where: { conceptId: e.dstId, matchedFailureMode: e.failureMode },
    });
    if (observed > 0) continue;

    out.push({
      edgeId: e.id,
      srcName: e.src.canonicalName,
      dstName: e.dst.canonicalName,
      failureMode: e.failureMode!,
      attempts,
      observed,
    });
  }
  return out.sort((a, b) => b.attempts - a.attempts);
}

export interface UnusedPrerequisite {
  edgeId: string;
  srcName: string;
  dstName: string;
  /** Learners who reached the target without ever demonstrating the prerequisite. */
  bypassed: number;
  total: number;
  bypassRate: number;
}

/**
 * A "hard" prerequisite that learners routinely succeed without is not hard. Same idea
 * as an unobserved failure mode, measured from the other side. (11)
 */
export async function findBypassedPrerequisites(
  prisma: PrismaClient,
  minLearners = 10,
): Promise<UnusedPrerequisite[]> {
  const rows = await prisma.$queryRawUnsafe<
    { edgeId: string; srcName: string; dstName: string; bypassed: bigint; total: bigint }[]
  >(`
    WITH success AS (
      SELECT DISTINCT e."learnerId", e."conceptId", MIN(e."createdAt") AS at
        FROM "EvidenceEvent" e
       WHERE e.kind IN ('applied', 'transferred')
       GROUP BY 1, 2
    )
    SELECT g.id AS "edgeId",
           s.name AS "srcName",
           d.name AS "dstName",
           COUNT(*) FILTER (WHERE pre.at IS NULL) AS bypassed,
           COUNT(*) AS total
      FROM "Edge" g
      JOIN (SELECT id, "canonicalName" AS name FROM "Concept") s ON s.id = g."srcId"
      JOIN (SELECT id, "canonicalName" AS name FROM "Concept") d ON d.id = g."dstId"
      JOIN success tgt ON tgt."conceptId" = g."dstId"
      LEFT JOIN success pre
             ON pre."learnerId" = tgt."learnerId"
            AND pre."conceptId" = g."srcId"
            AND pre.at < tgt.at
     WHERE g.type = 'prerequisite_of'
       AND g.strength = 'hard'
       AND g."retiredAt" IS NULL
     GROUP BY g.id, s.name, d.name
  `);

  return rows
    .map((r) => ({
      edgeId: r.edgeId,
      srcName: r.srcName,
      dstName: r.dstName,
      bypassed: Number(r.bypassed),
      total: Number(r.total),
      bypassRate: Number(r.total) === 0 ? 0 : Number(r.bypassed) / Number(r.total),
    }))
    .filter((r) => r.total >= minLearners && r.bypassRate > 0.7)
    .sort((a, b) => b.bypassRate - a.bypassRate);
}

/**
 * Human attention is the scarce resource, so review is ordered by how many learners
 * actually cross an edge. Most of the graph will never be traversed by anyone. (15)
 */
export async function reviewQueueByTraversal(
  prisma: PrismaClient,
  limit = 50,
): Promise<{ edgeId: string; srcName: string; dstName: string; traversals: number; provisional: boolean }[]> {
  const rows = await prisma.$queryRawUnsafe<
    { edgeId: string; srcName: string; dstName: string; traversals: bigint; provisional: boolean }[]
  >(
    `
    SELECT g.id AS "edgeId",
           s."canonicalName" AS "srcName",
           d."canonicalName" AS "dstName",
           COUNT(DISTINCT ps."planId") AS traversals,
           g.provisional
      FROM "Edge" g
      JOIN "Concept" s ON s.id = g."srcId"
      JOIN "Concept" d ON d.id = g."dstId"
      LEFT JOIN "PlanStep" ps ON ps."conceptId" = g."dstId"
     WHERE g.type = 'prerequisite_of'
       AND g.strength = 'hard'
       AND g."retiredAt" IS NULL
     GROUP BY g.id, s."canonicalName", d."canonicalName", g.provisional
     ORDER BY g.provisional DESC, traversals DESC
     LIMIT $1
  `,
    limit,
  );
  return rows.map((r) => ({ ...r, traversals: Number(r.traversals) }));
}
