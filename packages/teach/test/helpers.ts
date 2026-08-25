import { PrismaClient } from "@kg/db";

export const prisma = new PrismaClient();

export async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "EvidenceEvent", "Misconception", "LearnerConceptState", "AssessmentItem",
      "Edge", "ConceptAlias", "ConceptProposal", "Concept", "Learner", "Session"
      RESTART IDENTITY CASCADE`,
  );
}

let n = 0;
export async function concept(name: string): Promise<string> {
  const c = await prisma.concept.create({
    data: { canonicalName: name, sense: `sense ${name} ${n++}` },
  });
  return c.id;
}

export async function learner(): Promise<string> {
  const l = await prisma.learner.create({ data: { email: `l${n++}@x.test` } });
  return l.id;
}

export async function hardEdge(srcId: string, dstId: string, failureMode: string): Promise<string> {
  const e = await prisma.edge.create({
    data: { srcId, dstId, type: "prerequisite_of", strength: "hard", failureMode },
  });
  return e.id;
}
