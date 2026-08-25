-- `applied_in` runs Concept -> Topic (decision 08), which "Edge" cannot express since
-- it joins Concepts only. Both Topic-side relations live here instead.
CREATE TYPE "TopicRelation" AS ENUM ('contains', 'applied_in');

ALTER TABLE "TopicConcept" ADD COLUMN "relation" "TopicRelation" NOT NULL DEFAULT 'contains';
ALTER TABLE "TopicConcept" ADD COLUMN "relevance" DOUBLE PRECISION NOT NULL DEFAULT 0.5;

-- A concept can both belong to a topic and be applied in it; those are different facts.
DROP INDEX "TopicConcept_topicId_conceptId_key";
CREATE UNIQUE INDEX "TopicConcept_topicId_conceptId_relation_key"
  ON "TopicConcept"("topicId", "conceptId", "relation");
