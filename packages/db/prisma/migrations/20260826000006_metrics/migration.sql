CREATE TYPE "ProposalOutcome" AS ENUM ('created', 'bound');
ALTER TABLE "ConceptProposal" ADD COLUMN "outcome" "ProposalOutcome";

CREATE TABLE "UsageRecord" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT,
  "learnerId" TEXT,
  "purpose" TEXT NOT NULL,
  "tier" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "promptTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "UsageRecord_purpose_createdAt_idx" ON "UsageRecord"("purpose", "createdAt");
CREATE INDEX "UsageRecord_learnerId_createdAt_idx" ON "UsageRecord"("learnerId", "createdAt");
CREATE INDEX "UsageRecord_sessionId_idx" ON "UsageRecord"("sessionId");
