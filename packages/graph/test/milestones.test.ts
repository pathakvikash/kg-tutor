import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { LLMProvider } from "@kg/llm";
import { generateMilestones } from "../src/milestones.js";
import { prisma, reset } from "./helpers.js";

function llmReturning(milestones: unknown): LLMProvider {
  return { name: "stub", complete: async () => JSON.stringify({ milestones }) };
}

async function topicWith(names: string[]) {
  const topic = await prisma.topic.create({
    data: { name: `T${Math.random().toString(36).slice(2, 8)}`, description: "" },
  });
  for (const n of names) {
    const c = await prisma.concept.create({ data: { canonicalName: n, sense: `sense of ${n}` } });
    await prisma.topicConcept.create({
      data: { topicId: topic.id, conceptId: c.id, direct: true, relevance: 0.8, relation: "contains" },
    });
  }
  return topic.id;
}

beforeEach(reset);
afterAll(async () => { await prisma.$disconnect(); });

describe("generateMilestones", () => {
  const three = ["Stack", "Queue", "Deque"];

  it("writes a claim and its required concepts", async () => {
    const topicId = await topicWith(three);
    const r = await generateMilestones(
      prisma,
      llmReturning([{ claim: "you can choose the right linear structure", concepts: ["Stack", "Queue"] }]),
      topicId,
    );
    expect(r.written).toHaveLength(1);
    const t = await prisma.milestoneTemplate.findFirstOrThrow({
      where: { topicId }, include: { concepts: true },
    });
    expect(t.claim).toBe("you can choose the right linear structure");
    expect(t.concepts).toHaveLength(2);
  });

  /** A claim resting on one concept is that concept, not a capability worth finishing. */
  it("rejects a claim that rests on a single concept", async () => {
    const topicId = await topicWith(three);
    const r = await generateMilestones(
      prisma,
      llmReturning([{ claim: "you can reverse a list with a stack", concepts: ["Stack"] }]),
      topicId,
    );
    expect(r.written).toHaveLength(0);
    expect(r.rejected[0]?.reason).toBe("rests on a single concept");
  });

  // An empty milestone would hand out a completion for nothing.
  it("rejects a claim whose concepts do not exist", async () => {
    const topicId = await topicWith(three);
    const r = await generateMilestones(
      prisma,
      llmReturning([{ claim: "you can balance a red-black tree", concepts: ["Red-Black Tree", "Rotation"] }]),
      topicId,
    );
    expect(r.written).toHaveLength(0);
    expect(r.rejected[0]?.reason).toBe("named no concept that exists");
  });

  it("keeps the concepts that exist and drops the invented ones", async () => {
    const topicId = await topicWith(three);
    const r = await generateMilestones(
      prisma,
      llmReturning([{ claim: "you can pick an ordering structure", concepts: ["Stack", "Queue", "Skip List"] }]),
      topicId,
    );
    expect(r.written[0]?.concepts).toEqual(["Stack", "Queue"]);
  });

  it("does not duplicate a concept named twice in one claim", async () => {
    const topicId = await topicWith(three);
    const r = await generateMilestones(
      prisma,
      llmReturning([{ claim: "you can use both ends of a queue", concepts: ["Deque", "Deque", "Queue"] }]),
      topicId,
    );
    expect(r.written[0]?.concepts).toEqual(["Deque", "Queue"]);
  });

  it("leaves a topic that already has milestones alone", async () => {
    const topicId = await topicWith(three);
    await generateMilestones(
      prisma,
      llmReturning([{ claim: "you can choose a linear structure", concepts: ["Stack", "Queue"] }]),
      topicId,
    );
    const second = await generateMilestones(
      prisma,
      llmReturning([{ claim: "something else entirely", concepts: ["Stack", "Deque"] }]),
      topicId,
    );
    expect(second.written).toHaveLength(0);
    expect(await prisma.milestoneTemplate.count({ where: { topicId } })).toBe(1);
  });

  it("does not try on a topic too small to claim a capability for", async () => {
    const topicId = await topicWith(["Stack", "Queue"]);
    const r = await generateMilestones(
      prisma,
      llmReturning([{ claim: "you can do the thing", concepts: ["Stack", "Queue"] }]),
      topicId,
    );
    expect(r.written).toHaveLength(0);
    expect(await prisma.milestoneTemplate.count({ where: { topicId } })).toBe(0);
  });

  it("ignores a deprecated concept when naming what is available", async () => {
    const topicId = await topicWith([...three, "Arrays or Linked Lists"]);
    const compound = await prisma.concept.findFirstOrThrow({
      where: { canonicalName: "Arrays or Linked Lists" },
    });
    await prisma.concept.update({ where: { id: compound.id }, data: { deprecatedAt: new Date() } });
    const r = await generateMilestones(
      prisma,
      llmReturning([{ claim: "you can pick a sequence type", concepts: ["Stack", "Arrays or Linked Lists"] }]),
      topicId,
    );
    // Only Stack survives, so the claim rests on one concept and is refused.
    expect(r.written).toHaveLength(0);
    expect(r.rejected[0]?.reason).toBe("rests on a single concept");
  });
});
