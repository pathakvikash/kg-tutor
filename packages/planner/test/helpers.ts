import { PrismaClient, type MasteryLevel } from "@kg/db";

export const prisma = new PrismaClient();

export async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "PlanStep", "MilestoneInstance", "Plan", "Goal", "MilestoneConcept",
      "MilestoneTemplate", "TopicConcept", "LearnerConceptState", "Edge",
      "ConceptAlias", "ConceptProposal", "Concept", "Topic", "Learner"
      RESTART IDENTITY CASCADE`,
  );
}

let seq = 0;
export async function concept(name: string): Promise<string> {
  const c = await prisma.concept.create({
    data: { canonicalName: name, sense: `sense of ${name} #${seq++}` },
  });
  return c.id;
}

export async function hard(srcId: string, dstId: string): Promise<void> {
  await prisma.edge.create({
    data: {
      srcId, dstId, type: "prerequisite_of", strength: "hard",
      failureMode: "The learner produces a specific concrete wrong answer here.",
    },
  });
}

export async function contains(
  topicId: string, conceptId: string, direct = true, relevance = 0.5,
): Promise<void> {
  await prisma.topicConcept.create({
    data: { topicId, conceptId, direct, relevance, relation: "contains" },
  });
}

export async function setMastery(
  learnerId: string, conceptId: string, mastery: MasteryLevel,
): Promise<void> {
  await prisma.learnerConceptState.upsert({
    where: { learnerId_conceptId: { learnerId, conceptId } },
    create: { learnerId, conceptId, mastery, confidence: 0.9, source: "assessed" },
    update: { mastery, confidence: 0.9 },
  });
}
