-- Lexical similarity is one of the three candidate-generation arms. (05)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX concept_name_trgm_idx ON "Concept" USING gin ("canonicalName" gin_trgm_ops);
CREATE INDEX concept_alias_name_trgm_idx ON "ConceptAlias" USING gin ("name" gin_trgm_ops);

-- A proposal has no edges yet, so neighborhood overlap is measured against the
-- concepts it was discovered next to.
ALTER TABLE "ConceptProposal" ADD COLUMN "expectedNeighborIds" TEXT[] NOT NULL DEFAULT '{}';
