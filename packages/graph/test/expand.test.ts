import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { ScriptedLLM } from "@kg/llm";
import { expandTopicShallow } from "../src/expand.js";
import { LLMAdjudicator } from "../src/adjudicate-llm.js";
import { DeterministicEmbedding } from "../src/embedding.js";
import { prisma, reset } from "./helpers.js";

const FM_SCOPE =
  "The learner expects a captured variable to hold the value it had when the function was defined.";
const FM_FUNC =
  "The learner reads a returned inner function as having already run, and expects its result.";

/**
 * Scripted so the test measures our consensus, resolver and edge discipline rather
 * than a model. Concept sampling is deliberately noisy: `closures` and `scope` appear
 * in all three samples, while three one-off items appear once each.
 */
function scriptedModel() {
  const concepts = [
    { concepts: [
      { name: "closures", sense: "A function together with the scope it captured." },
      { name: "scope", sense: "The region of code where a binding is visible." },
      { name: "hoisting", sense: "Declaration processing before execution." },
    ] },
    { concepts: [
      { name: "Closures", sense: "A function plus its captured scope." },
      { name: "scope", sense: "The region of code where a binding is visible." },
      { name: "currying", sense: "Turning a multi-argument function into a chain." },
    ] },
    { concepts: [
      { name: "closures", sense: "A function together with the scope it captured." },
      { name: "Scope", sense: "Where a binding is visible." },
      { name: "IIFE", sense: "A function invoked as soon as it is defined." },
    ] },
  ];

  const prereqs: Record<string, unknown> = {
    closures: { prerequisites: [
      { name: "functions", sense: "A named, reusable unit of computation.",
        strength: "hard", failureMode: FM_FUNC },
      // Consistently proposed as hard, but with empty justification -> must land soft.
      { name: "scope", sense: "The region of code where a binding is visible.",
        strength: "hard", failureMode: "The learner will not fully understand closures." },
    ] },
    scope: { prerequisites: [
      { name: "functions", sense: "A named, reusable unit of computation.",
        strength: "hard", failureMode: FM_SCOPE },
    ] },
  };

  let conceptCall = 0;
  return new ScriptedLLM((req) => {
    if (req.system.includes("break a learning topic")) {
      return JSON.stringify(concepts[conceptCall++ % concepts.length]);
    }
    if (req.system.includes("immediate prerequisites")) {
      const match = /Concept: (.+)/.exec(req.user)?.[1]?.trim().toLowerCase() ?? "";
      return JSON.stringify(prereqs[match] ?? { prerequisites: [] });
    }
    // Adjudication: nothing here is a duplicate of anything else.
    return JSON.stringify({ verdict: "distinct", relatedConceptId: null, reasoning: "scripted" });
  });
}

beforeEach(reset);
afterAll(async () => { await prisma.$disconnect(); });

describe("expandTopicShallow", () => {
  it("keeps consensus concepts, drops the one-off tail, and records what it dropped", async () => {
    const llm = scriptedModel();
    const report = await expandTopicShallow({
      topicName: "JavaScript functions",
      llm,
      prisma,
      resolver: {
        prisma,
        embedding: new DeterministicEmbedding(),
        adjudicator: new LLMAdjudicator(llm),
      },
    });

    const names = (await prisma.concept.findMany()).map((c) => c.canonicalName.toLowerCase());
    expect(names).toContain("closures");
    expect(names).toContain("scope");
    expect(names).toContain("functions"); // arrived as a prerequisite
    for (const oneOff of ["hoisting", "currying", "iife"]) {
      expect(names).not.toContain(oneOff);
    }
    expect(report.conceptsDroppedByConsensus.map((s) => s.toLowerCase()).sort())
      .toEqual(["currying", "hoisting", "iife"]);
  });

  it("writes hard edges only where the failure mode survives validation", async () => {
    const llm = scriptedModel();
    const report = await expandTopicShallow({
      topicName: "JavaScript functions",
      llm,
      prisma,
      resolver: {
        prisma, embedding: new DeterministicEmbedding(), adjudicator: new LLMAdjudicator(llm),
      },
    });

    const edges = await prisma.edge.findMany({ include: { src: true, dst: true } });
    const hard = edges.filter((e) => e.strength === "hard");
    const soft = edges.filter((e) => e.strength === "soft");

    // functions -> closures and functions -> scope carry real failure modes.
    expect(hard.map((e) => `${e.src.canonicalName}->${e.dst.canonicalName}`.toLowerCase()).sort())
      .toEqual(["functions->closures", "functions->scope"]);
    expect(hard.every((e) => e.failureMode && e.failureMode.length > 20)).toBe(true);

    // scope -> closures was proposed hard with empty justification, so it landed soft.
    const demoted = soft.find((e) => e.src.canonicalName.toLowerCase() === "scope");
    expect(demoted, "unjustified hard edge should be kept as soft, not dropped").toBeDefined();
    expect(demoted?.failureMode).toBeNull();
    expect(report.edgesDemoted).toBe(1);
  });

  it("links concepts to the topic, marking prerequisites as indirect", async () => {
    const llm = scriptedModel();
    const { topicId } = await expandTopicShallow({
      topicName: "JavaScript functions",
      llm, prisma,
      resolver: {
        prisma, embedding: new DeterministicEmbedding(), adjudicator: new LLMAdjudicator(llm),
      },
    });

    const links = await prisma.topicConcept.findMany({
      where: { topicId }, include: { concept: true },
    });
    const byName = Object.fromEntries(
      links.map((l) => [l.concept.canonicalName.toLowerCase(), l.direct]),
    );
    expect(byName["closures"]).toBe(true);
    expect(byName["scope"]).toBe(true);
    expect(byName["functions"]).toBe(false); // pulled in as a prerequisite
  });

  it("is idempotent — re-expanding binds instead of duplicating", async () => {
    const opts = () => {
      const llm = scriptedModel();
      return {
        topicName: "JavaScript functions", llm, prisma,
        resolver: {
          prisma, embedding: new DeterministicEmbedding(), adjudicator: new LLMAdjudicator(llm),
        },
      };
    };
    const first = await expandTopicShallow(opts());
    const countAfterFirst = await prisma.concept.count();

    const second = await expandTopicShallow(opts());
    expect(await prisma.concept.count()).toBe(countAfterFirst);
    expect(second.conceptsCreated).toBe(0);
    expect(second.conceptsBound).toBe(first.conceptsCreated + first.conceptsBound);
    expect(await prisma.topic.count()).toBe(1);
  });
});
