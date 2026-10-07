import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { ScriptedLLM } from "@kg/llm";
import { baselineTurn, assignVariant, BASELINE_SYSTEM_PROMPT } from "../src/baseline.js";
import { prisma, reset, learner } from "./helpers.js";

beforeEach(reset);
afterAll(async () => { await prisma.$disconnect(); });

describe("baselineTurn", () => {
  it("answers from history alone and writes no learner state", async () => {
    const l = await learner();
    const session = await prisma.session.create({ data: { learnerId: l, variant: "baseline" } });
    const llm = new ScriptedLLM(() => "A closure is a function plus its captured scope.");

    const reply = await baselineTurn({
      prisma, llm, sessionId: session.id,
      history: [{ role: "learner", text: "teach me closures" }],
      message: "what is a closure?",
    });

    expect(reply).toContain("captured scope");
    expect(llm.calls[0]?.system).toBe(BASELINE_SYSTEM_PROMPT);
    expect(llm.calls[0]?.tier).toBe("strong");

    expect(await prisma.evidenceEvent.count()).toBe(0);
    expect(await prisma.learnerConceptState.count()).toBe(0);
    expect(await prisma.usageRecord.count({ where: { sessionId: session.id } })).toBe(1);
  });
});

describe("assignVariant", () => {
  it("is stable for a learner across calls", () => {
    const id = "learner-abc-123";
    expect(assignVariant(id)).toBe(assignVariant(id));
  });

  it("splits roughly evenly across many learners", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `learner-${i}`);
    const graph = ids.filter((id) => assignVariant(id) === "graph").length;
    expect(graph / ids.length).toBeGreaterThan(0.4);
    expect(graph / ids.length).toBeLessThan(0.6);
  });

  it("honours a skewed split", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `l-${i}`);
    const graph = ids.filter((id) => assignVariant(id, 0.9) === "graph").length;
    expect(graph / ids.length).toBeGreaterThan(0.85);
  });
});
