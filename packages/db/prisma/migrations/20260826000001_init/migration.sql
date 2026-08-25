-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "EdgeType" AS ENUM ('prerequisite_of', 'contains', 'related_to', 'applied_in', 'extends');

-- CreateEnum
CREATE TYPE "EdgeStrength" AS ENUM ('hard', 'soft');

-- CreateEnum
CREATE TYPE "MasteryLevel" AS ENUM ('unknown', 'familiar', 'functional', 'solid');

-- CreateEnum
CREATE TYPE "EvidenceSource" AS ENUM ('self_reported', 'assessed', 'taught', 'inferred');

-- CreateEnum
CREATE TYPE "GoalDepth" AS ENUM ('use', 'debug', 'build');

-- CreateEnum
CREATE TYPE "ResolverVerdict" AS ENUM ('same', 'narrower', 'broader', 'related', 'distinct');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('open', 'accepted', 'rejected');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('candidate', 'canonical', 'retired');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('restated', 'applied', 'transferred', 'failed_check', 'misconception_shown', 'careless_error', 'self_reported_skip', 'spontaneous_prerequisite_request', 'downstream_success', 'reprobe_pass', 'reprobe_fail');

-- CreateTable
CREATE TABLE "Topic" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'subject',
    "description" TEXT NOT NULL,
    "isDagLike" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Concept" (
    "id" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "sense" TEXT NOT NULL,
    "senseVector" vector(1536),
    "description" TEXT NOT NULL DEFAULT '',
    "deprecatedAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Concept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConceptAlias" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConceptAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Edge" (
    "id" TEXT NOT NULL,
    "srcId" TEXT NOT NULL,
    "dstId" TEXT NOT NULL,
    "type" "EdgeType" NOT NULL,
    "strength" "EdgeStrength" NOT NULL DEFAULT 'soft',
    "failureMode" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "provisional" BOOLEAN NOT NULL DEFAULT false,
    "promotedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "retiredReason" TEXT,

    CONSTRAINT "Edge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConceptProposal" (
    "id" TEXT NOT NULL,
    "proposedName" TEXT NOT NULL,
    "proposedSense" TEXT NOT NULL,
    "context" TEXT,
    "verdict" "ResolverVerdict",
    "resolvedToId" TEXT,
    "candidates" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConceptProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MergeRecord" (
    "id" TEXT NOT NULL,
    "winnerId" TEXT NOT NULL,
    "loserId" TEXT NOT NULL,
    "rewrittenEdges" JSONB NOT NULL,
    "movedStates" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MergeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentItem" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "prompt" TEXT NOT NULL,
    "rubric" JSONB NOT NULL,
    "targetsLevel" "MasteryLevel" NOT NULL DEFAULT 'functional',
    "requiresTransfer" BOOLEAN NOT NULL DEFAULT false,
    "status" "ContentStatus" NOT NULL DEFAULT 'candidate',
    "timesUsed" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "discrimination" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssessmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExplanationContent" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "ContentStatus" NOT NULL DEFAULT 'candidate',
    "claims" TEXT NOT NULL,
    "examples" JSONB NOT NULL DEFAULT '[]',
    "analogies" JSONB NOT NULL DEFAULT '[]',
    "bucket" TEXT,
    "timesShown" INTEGER NOT NULL DEFAULT 0,
    "followedByPass" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExplanationContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Learner" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "background" TEXT,
    "orgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Learner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearnerConceptState" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "mastery" "MasteryLevel" NOT NULL DEFAULT 'unknown',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source" "EvidenceSource" NOT NULL DEFAULT 'inferred',
    "lastEvidenceAt" TIMESTAMP(3),
    "reprobeQueuedAt" TIMESTAMP(3),
    "blockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnerConceptState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Misconception" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "belief" TEXT NOT NULL,
    "matchedFailureMode" TEXT,
    "observedCount" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Misconception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceEvent" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "sessionId" TEXT,
    "kind" "EvidenceKind" NOT NULL,
    "itemId" TEXT,
    "contentId" TEXT,
    "referencedConceptId" TEXT,
    "response" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionProposal" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "srcId" TEXT,
    "dstId" TEXT,
    "claim" TEXT NOT NULL,
    "distinctLearners" INTEGER NOT NULL DEFAULT 0,
    "effectSize" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "controlFailureRate" DOUBLE PRECISION,
    "treatmentFailureRate" DOUBLE PRECISION,
    "distinctGoals" INTEGER NOT NULL DEFAULT 0,
    "evidencePacket" JSONB NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'open',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "depth" "GoalDepth" NOT NULL DEFAULT 'use',
    "constraints" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneTemplate" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "ordering" INTEGER NOT NULL DEFAULT 0,
    "status" "ContentStatus" NOT NULL DEFAULT 'candidate',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MilestoneTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneConcept" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "requiredLevel" "MasteryLevel" NOT NULL DEFAULT 'functional',

    CONSTRAINT "MilestoneConcept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "revisionReason" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanStep" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "requiredLevel" "MasteryLevel" NOT NULL DEFAULT 'functional',
    "committed" BOOLEAN NOT NULL DEFAULT false,
    "unlockCount" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PlanStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneInstance" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "foldedForward" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MilestoneInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "variant" TEXT NOT NULL DEFAULT 'graph',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlannerDecision" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "candidates" JSONB NOT NULL,
    "selected" JSONB NOT NULL,
    "reasonCodes" TEXT[],
    "stateSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlannerDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Topic_name_key" ON "Topic"("name");

-- CreateIndex
CREATE INDEX "Concept_canonicalName_idx" ON "Concept"("canonicalName");

-- CreateIndex
CREATE INDEX "Concept_deprecatedAt_idx" ON "Concept"("deprecatedAt");

-- CreateIndex
CREATE INDEX "ConceptAlias_conceptId_idx" ON "ConceptAlias"("conceptId");

-- CreateIndex
CREATE UNIQUE INDEX "ConceptAlias_name_key" ON "ConceptAlias"("name");

-- CreateIndex
CREATE INDEX "Edge_dstId_type_strength_idx" ON "Edge"("dstId", "type", "strength");

-- CreateIndex
CREATE INDEX "Edge_srcId_type_strength_idx" ON "Edge"("srcId", "type", "strength");

-- CreateIndex
CREATE UNIQUE INDEX "Edge_srcId_dstId_type_key" ON "Edge"("srcId", "dstId", "type");

-- CreateIndex
CREATE INDEX "ConceptProposal_resolvedAt_idx" ON "ConceptProposal"("resolvedAt");

-- CreateIndex
CREATE INDEX "MergeRecord_loserId_idx" ON "MergeRecord"("loserId");

-- CreateIndex
CREATE INDEX "AssessmentItem_conceptId_status_idx" ON "AssessmentItem"("conceptId", "status");

-- CreateIndex
CREATE INDEX "ExplanationContent_conceptId_status_bucket_idx" ON "ExplanationContent"("conceptId", "status", "bucket");

-- CreateIndex
CREATE UNIQUE INDEX "Learner_email_key" ON "Learner"("email");

-- CreateIndex
CREATE INDEX "Learner_orgId_idx" ON "Learner"("orgId");

-- CreateIndex
CREATE INDEX "LearnerConceptState_learnerId_mastery_idx" ON "LearnerConceptState"("learnerId", "mastery");

-- CreateIndex
CREATE INDEX "LearnerConceptState_conceptId_idx" ON "LearnerConceptState"("conceptId");

-- CreateIndex
CREATE UNIQUE INDEX "LearnerConceptState_learnerId_conceptId_key" ON "LearnerConceptState"("learnerId", "conceptId");

-- CreateIndex
CREATE INDEX "Misconception_learnerId_conceptId_idx" ON "Misconception"("learnerId", "conceptId");

-- CreateIndex
CREATE INDEX "Misconception_conceptId_resolvedAt_idx" ON "Misconception"("conceptId", "resolvedAt");

-- CreateIndex
CREATE INDEX "EvidenceEvent_conceptId_kind_createdAt_idx" ON "EvidenceEvent"("conceptId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "EvidenceEvent_learnerId_createdAt_idx" ON "EvidenceEvent"("learnerId", "createdAt");

-- CreateIndex
CREATE INDEX "EvidenceEvent_sessionId_idx" ON "EvidenceEvent"("sessionId");

-- CreateIndex
CREATE INDEX "PromotionProposal_status_effectSize_idx" ON "PromotionProposal"("status", "effectSize");

-- CreateIndex
CREATE INDEX "Goal_learnerId_active_idx" ON "Goal"("learnerId", "active");

-- CreateIndex
CREATE INDEX "MilestoneTemplate_topicId_ordering_idx" ON "MilestoneTemplate"("topicId", "ordering");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneConcept_templateId_conceptId_key" ON "MilestoneConcept"("templateId", "conceptId");

-- CreateIndex
CREATE INDEX "Plan_learnerId_supersededAt_idx" ON "Plan"("learnerId", "supersededAt");

-- CreateIndex
CREATE INDEX "PlanStep_conceptId_idx" ON "PlanStep"("conceptId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanStep_planId_position_key" ON "PlanStep"("planId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneInstance_planId_position_key" ON "MilestoneInstance"("planId", "position");

-- CreateIndex
CREATE INDEX "Session_learnerId_startedAt_idx" ON "Session"("learnerId", "startedAt");

-- CreateIndex
CREATE INDEX "PlannerDecision_sessionId_createdAt_idx" ON "PlannerDecision"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "Concept" ADD CONSTRAINT "Concept_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "Concept"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptAlias" ADD CONSTRAINT "ConceptAlias_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Edge" ADD CONSTRAINT "Edge_srcId_fkey" FOREIGN KEY ("srcId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Edge" ADD CONSTRAINT "Edge_dstId_fkey" FOREIGN KEY ("dstId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Edge" ADD CONSTRAINT "Edge_promotedById_fkey" FOREIGN KEY ("promotedById") REFERENCES "PromotionProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentItem" ADD CONSTRAINT "AssessmentItem_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExplanationContent" ADD CONSTRAINT "ExplanationContent_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnerConceptState" ADD CONSTRAINT "LearnerConceptState_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "Learner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnerConceptState" ADD CONSTRAINT "LearnerConceptState_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Misconception" ADD CONSTRAINT "Misconception_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "Learner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Misconception" ADD CONSTRAINT "Misconception_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceEvent" ADD CONSTRAINT "EvidenceEvent_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "Learner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceEvent" ADD CONSTRAINT "EvidenceEvent_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceEvent" ADD CONSTRAINT "EvidenceEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceEvent" ADD CONSTRAINT "EvidenceEvent_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "AssessmentItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceEvent" ADD CONSTRAINT "EvidenceEvent_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ExplanationContent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "Learner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneTemplate" ADD CONSTRAINT "MilestoneTemplate_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneConcept" ADD CONSTRAINT "MilestoneConcept_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MilestoneTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneConcept" ADD CONSTRAINT "MilestoneConcept_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "Learner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanStep" ADD CONSTRAINT "PlanStep_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanStep" ADD CONSTRAINT "PlanStep_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneInstance" ADD CONSTRAINT "MilestoneInstance_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneInstance" ADD CONSTRAINT "MilestoneInstance_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MilestoneTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "Learner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannerDecision" ADD CONSTRAINT "PlannerDecision_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

