CREATE TABLE "IntakeSession" (
  "id" TEXT NOT NULL,
  "learnerId" TEXT NOT NULL,
  "topicId" TEXT NOT NULL,
  "depth" TEXT NOT NULL DEFAULT 'use',
  "goalText" TEXT,
  "state" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'asking',
  "currentConceptId" TEXT,
  "currentItemId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntakeSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IntakeSession_learnerId_status_idx" ON "IntakeSession"("learnerId", "status");

CREATE TABLE "AppSetting" (
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);
