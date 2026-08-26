import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { splitCompoundConcept } from "../src/split.js";
import { prisma, reset, alwaysDistinct, deps } from "./helpers.js";

async function compound(name: string, sense = "two things at once") {
  const c = await prisma.concept.create({ data: { canonicalName: name, sense } });
  return c.id;
}

beforeEach(reset);
afterAll(async () => { await prisma.$disconnect(); });

describe("splitCompoundConcept", () => {
  it("leaves a name that denotes one concept alone", async () => {
    const id = await compound("Hash Table", "maps keys to values via a hash function");
    expect(await splitCompoundConcept(prisma, deps(alwaysDistinct), id)).toBeNull();
  });

  it("rewrites each edge onto every half", async () => {
    const before = await compound("array indexing", "reading an element by position");
    const after = await compound("Hash Collision Resolution", "handling two keys in one bucket");
    const id = await compound("Hash Functions and Hash Tables");
    await prisma.edge.create({
      data: {
        srcId: before, dstId: id, type: "prerequisite_of", strength: "hard",
        failureMode: "The learner expects two distinct keys never to land in one bucket.",
      },
    });
    await prisma.edge.create({
      data: { srcId: id, dstId: after, type: "prerequisite_of", strength: "soft" },
    });

    const r = await splitCompoundConcept(prisma, deps(alwaysDistinct), id);
    expect(r).not.toBeNull();
    expect(r!.parts.map((p) => p.name)).toEqual(["Hash Functions", "Hash Tables"]);
    // Two edges, two halves, so four live edges — and the originals retired.
    expect(r!.edgesRewritten).toBe(4);

    for (const part of r!.parts) {
      const incoming = await prisma.edge.findFirst({
        where: { srcId: before, dstId: part.conceptId, retiredAt: null },
      });
      expect(incoming?.strength).toBe("hard");
      // The failure mode has to survive: a hard edge without one violates the DB guard.
      expect(incoming?.failureMode).toContain("one bucket");
      const outgoing = await prisma.edge.findFirst({
        where: { srcId: part.conceptId, dstId: after, retiredAt: null },
      });
      expect(outgoing).not.toBeNull();
    }
    const live = await prisma.edge.count({
      where: { OR: [{ srcId: id }, { dstId: id }], retiredAt: null },
    });
    expect(live).toBe(0);
  });

  it("deprecates the compound so the planner stops reaching it", async () => {
    const id = await compound("Big-O / Amortized Analysis");
    const r = await splitCompoundConcept(prisma, deps(alwaysDistinct), id);
    const after = await prisma.concept.findUniqueOrThrow({ where: { id } });
    expect(after.deprecatedAt).not.toBeNull();
    expect(after.supersededById).toBe(r!.parts[0]!.conceptId);
  });

  it("carries topic membership to both halves", async () => {
    const topic = await prisma.topic.create({ data: { name: "DS", description: "" } });
    const id = await compound("Arrays or Linked Lists");
    await prisma.topicConcept.create({
      data: { topicId: topic.id, conceptId: id, direct: true, relevance: 0.8, relation: "contains" },
    });
    const r = await splitCompoundConcept(prisma, deps(alwaysDistinct), id);
    for (const part of r!.parts) {
      const link = await prisma.topicConcept.findFirst({
        where: { topicId: topic.id, conceptId: part.conceptId },
      });
      expect(link?.direct).toBe(true);
    }
  });

  /**
   * A level recorded against a compound was never a measurement of one thing. Copying it
   * onto both halves would assert twice over what the learner never demonstrated once.
   */
  it("does not carry mastery onto the halves, and records that it did not", async () => {
    const learner = await prisma.learner.create({ data: { email: `s${Date.now()}@x.test` } });
    const id = await compound("Arrays or Linked Lists");
    await prisma.learnerConceptState.create({
      data: { learnerId: learner.id, conceptId: id, mastery: "functional", confidence: 0.8, source: "assessed" },
    });

    const r = await splitCompoundConcept(prisma, deps(alwaysDistinct), id);
    expect(r!.masteryRowsStranded).toBe(1);
    for (const part of r!.parts) {
      const state = await prisma.learnerConceptState.findFirst({
        where: { learnerId: learner.id, conceptId: part.conceptId },
      });
      expect(state).toBeNull();
    }
    const record = await prisma.mergeRecord.findFirst({ where: { loserId: id } });
    expect(record).not.toBeNull();
    expect(JSON.stringify(record!.movedStates)).toContain("masteryNotMoved");
  });

  it("retires items written for the compound", async () => {
    const id = await compound("Variables and memory allocation");
    await prisma.assessmentItem.create({
      data: {
        conceptId: id, prompt: "Explain both halves at once.",
        rubric: { mustDemonstrate: ["something"] }, targetsLevel: "functional",
        requiresTransfer: false, status: "candidate",
      },
    });
    const r = await splitCompoundConcept(prisma, deps(alwaysDistinct), id);
    expect(r!.itemsRetired).toBe(1);
  });

  it("deprecates a heading with no usable halves rather than guessing", async () => {
    const id = await compound("Graph connectivity concepts");
    const r = await splitCompoundConcept(prisma, deps(alwaysDistinct), id);
    expect(r!.parts).toEqual([]);
    const after = await prisma.concept.findUniqueOrThrow({ where: { id } });
    expect(after.deprecatedAt).not.toBeNull();
    expect(after.supersededById).toBeNull();
  });

  it("uses a supplied namer, and refuses a namer that returns another compound", async () => {
    const id = await compound("width and height properties");
    const r = await splitCompoundConcept(prisma, deps(alwaysDistinct), id, async () => [
      { name: "width property", sense: "the CSS declaration that sets an element's width" },
      { name: "height property", sense: "the CSS declaration that sets an element's height" },
      { name: "width and height together", sense: "still a compound, must be dropped" },
    ]);
    expect(r!.parts.map((p) => p.name)).toEqual(["width property", "height property"]);
  });
});
