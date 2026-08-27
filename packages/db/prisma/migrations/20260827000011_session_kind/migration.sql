-- A session is either a lesson or a review pass.
--
-- Hand-written rather than generated: `prisma migrate diff` also wants to DROP
-- concept_name_trgm_idx, concept_alias_name_trgm_idx and concept_sense_vector_idx,
-- which are created in raw SQL and invisible to the Prisma schema. They are the
-- resolver's lexical and vector retrieval.
ALTER TABLE "Session" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'lesson';
CREATE INDEX "Session_learnerId_kind_endedAt_idx" ON "Session"("learnerId", "kind", "endedAt");
