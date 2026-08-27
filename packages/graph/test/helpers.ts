import { PrismaClient } from "@kg/db";
import type { ResolverDecision } from "@kg/shared";
import { DeterministicEmbedding } from "../src/embedding.js";
import type { AdjudicationInput, Adjudicator } from "../src/adjudicate.js";

export const prisma = new PrismaClient();

export async function reset(): Promise<void> {
  // Topics too, or a leftover one leaks into suites that count topics globally.
  await prisma.$executeRawUnsafe(
    `TRUNCATE "Edge", "ConceptAlias", "ConceptProposal", "Concept",
      "TopicConcept", "MilestoneConcept", "MilestoneTemplate", "Topic"
      RESTART IDENTITY CASCADE`,
  );
}

/** Scripted adjudicator — the resolver's plumbing is under test, not a model. */
export class ScriptedAdjudicator implements Adjudicator {
  readonly name = "scripted";
  public calls: AdjudicationInput[] = [];

  constructor(private readonly script: (i: AdjudicationInput) => ResolverDecision) {}

  async adjudicate(input: AdjudicationInput): Promise<ResolverDecision> {
    this.calls.push(input);
    return this.script(input);
  }
}

export const alwaysDistinct = new ScriptedAdjudicator(() => ({
  verdict: "distinct",
  relatedConceptId: null,
  reasoning: "scripted",
}));

export function deps(adjudicator: Adjudicator) {
  return { prisma, embedding: new DeterministicEmbedding(), adjudicator };
}
