-- Topic -> Concept containment. "Edge" joins Concepts only, so this cannot live there. (02)
CREATE TABLE "TopicConcept" (
  "id" TEXT NOT NULL,
  "topicId" TEXT NOT NULL,
  "conceptId" TEXT NOT NULL,
  "direct" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TopicConcept_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TopicConcept_topicId_conceptId_key" ON "TopicConcept"("topicId", "conceptId");
CREATE INDEX "TopicConcept_conceptId_idx" ON "TopicConcept"("conceptId");

ALTER TABLE "TopicConcept" ADD CONSTRAINT "TopicConcept_topicId_fkey"
  FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TopicConcept" ADD CONSTRAINT "TopicConcept_conceptId_fkey"
  FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;
