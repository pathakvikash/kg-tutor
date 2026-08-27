import type { PrismaClient } from "@kg/db";
import type { ResolverCandidate } from "@kg/shared";
import { toVectorLiteral } from "./embedding.js";

export interface CandidateQuery {
  name: string;
  senseVector: number[];
  /** Concepts the proposal was discovered next to. (05) */
  expectedNeighborIds: string[];
  limit?: number;
}

interface Row {
  id: string;
  canonicalName: string;
  sense: string;
  vector_score: number | null;
  lexical_score: number | null;
  neighborhood_overlap: number | null;
  arms: string[];
}

/** Three arms in one round trip; ANN and lexical stay separate so their indexes are used. */
const SQL = `
WITH p AS (
  SELECT $1::vector AS v, $2::text AS name, $3::text[] AS expected
),
ann AS (
  SELECT c.id, 'ann' AS arm
    FROM "Concept" c, p
   WHERE c."deprecatedAt" IS NULL AND c."senseVector" IS NOT NULL
   ORDER BY c."senseVector" <=> p.v
   LIMIT $4
),
lex AS (
  SELECT c.id, 'lexical' AS arm
    FROM "Concept" c, p
   WHERE c."deprecatedAt" IS NULL
     AND (
       c."canonicalName" % p.name
       OR EXISTS (
         SELECT 1 FROM "ConceptAlias" a
          WHERE a."conceptId" = c.id AND a.name % p.name
       )
     )
   ORDER BY similarity(c."canonicalName", p.name) DESC
   LIMIT $4
),
local AS (
  SELECT DISTINCT c.id, 'graph' AS arm
    FROM "Concept" c, p
   WHERE c."deprecatedAt" IS NULL
     AND EXISTS (
       SELECT 1 FROM "Edge" e
        WHERE e."retiredAt" IS NULL
          AND (
            (e."srcId" = c.id AND e."dstId" = ANY(p.expected))
            OR (e."dstId" = c.id AND e."srcId" = ANY(p.expected))
          )
     )
   LIMIT $4
),
pool AS (
  SELECT id, array_agg(DISTINCT arm) AS arms
    FROM (SELECT * FROM ann UNION ALL SELECT * FROM lex UNION ALL SELECT * FROM local) u
   GROUP BY id
)
SELECT
  c.id,
  c."canonicalName",
  c.sense,
  CASE WHEN c."senseVector" IS NULL THEN NULL
       ELSE 1 - (c."senseVector" <=> p.v) END AS vector_score,
  GREATEST(
    similarity(c."canonicalName", p.name),
    COALESCE((SELECT MAX(similarity(a.name, p.name))
                FROM "ConceptAlias" a WHERE a."conceptId" = c.id), 0)
  ) AS lexical_score,
  CASE WHEN COALESCE(array_length(p.expected, 1), 0) = 0 THEN 0
       ELSE (
         SELECT COUNT(*)::float
           FROM (
             SELECT e."dstId" AS n FROM "Edge" e
              WHERE e."srcId" = c.id AND e."retiredAt" IS NULL
              UNION
             SELECT e."srcId" FROM "Edge" e
              WHERE e."dstId" = c.id AND e."retiredAt" IS NULL
           ) nb
          WHERE nb.n = ANY(p.expected)
       ) / array_length(p.expected, 1)::float
  END AS neighborhood_overlap,
  pool.arms
FROM pool
JOIN "Concept" c ON c.id = pool.id
CROSS JOIN p
ORDER BY
  COALESCE(CASE WHEN c."senseVector" IS NULL THEN NULL
                ELSE 1 - (c."senseVector" <=> p.v) END, 0) DESC
LIMIT $4;
`;

export async function findCandidates(
  prisma: PrismaClient,
  q: CandidateQuery,
): Promise<ResolverCandidate[]> {
  const limit = q.limit ?? 10;
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    SQL,
    toVectorLiteral(q.senseVector),
    q.name,
    q.expectedNeighborIds,
    limit,
  );
  return rows.map((r) => ({
    conceptId: r.id,
    canonicalName: r.canonicalName,
    sense: r.sense,
    vectorScore: r.vector_score ?? 0,
    lexicalScore: r.lexical_score ?? 0,
    neighborhoodOverlap: r.neighborhood_overlap ?? 0,
  }));
}

/** Which arms surfaced each candidate — useful when auditing why something was missed. */
export async function findCandidatesWithArms(
  prisma: PrismaClient,
  q: CandidateQuery,
): Promise<(ResolverCandidate & { arms: string[] })[]> {
  const limit = q.limit ?? 10;
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    SQL,
    toVectorLiteral(q.senseVector),
    q.name,
    q.expectedNeighborIds,
    limit,
  );
  return rows.map((r) => ({
    conceptId: r.id,
    canonicalName: r.canonicalName,
    sense: r.sense,
    vectorScore: r.vector_score ?? 0,
    lexicalScore: r.lexical_score ?? 0,
    neighborhoodOverlap: r.neighborhood_overlap ?? 0,
    arms: r.arms,
  }));
}
