CREATE TABLE "LessonTurn" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "learnerId" TEXT NOT NULL,
  "conceptId" TEXT,
  "role" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "meta" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LessonTurn_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LessonTurn_sessionId_createdAt_idx" ON "LessonTurn"("sessionId", "createdAt");
CREATE INDEX "LessonTurn_learnerId_createdAt_idx" ON "LessonTurn"("learnerId", "createdAt");
ALTER TABLE "LessonTurn" ADD CONSTRAINT "LessonTurn_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ExpansionJob" (
  "id" TEXT NOT NULL,
  "topicName" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "phase" TEXT NOT NULL DEFAULT 'starting',
  "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "report" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExpansionJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ExpansionJob_status_createdAt_idx" ON "ExpansionJob"("status", "createdAt");
