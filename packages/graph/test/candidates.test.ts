import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { findCandidatesWithArms } from "../src/candidates.js";
import { DeterministicEmbedding, identityText } from "../src/embedding.js";
import { proposeConcept, proposeEdge } from "../src/resolve.js";
import { prisma, reset, deps, alwaysDistinct } from "./helpers.js";

const embedding = new DeterministicEmbedding();

async function seed(name: string, sense: string) {
  const r = await proposeConcept(deps(alwaysDistinct), { name, sense });
  return r.conceptId;
}

async function search(name: string, sense: string, expected: string[] = []) {
  const [v] = await embedding.embed([identityText(name, sense)]);
  return findCandidatesWithArms(prisma, {
    name,
    senseVector: v!,
    expectedNeighborIds: expected,
  });
}

beforeEach(reset);
afterAll(async () => { await prisma.$disconnect(); });

describe("candidate generation", () => {
  it("returns nothing on an empty graph", async () => {
    expect(await search("closures", "A function plus its captured scope.")).toEqual([]);
  });

  it("finds a near-identical sense through the vector arm", async () => {
    const id = await seed("closures", "A function together with the scope it captured.");
    const hits = await search("closure", "A function together with the scope it captured.");
    expect(hits[0]?.conceptId).toBe(id);
    expect(hits[0]?.arms).toContain("ann");
    // The figure is a property of the deterministic stub; the rank is what matters.
    expect(hits[0]?.vectorScore).toBeGreaterThan(0.85);
  });

  it("finds a misspelled or abbreviated name through the lexical arm", async () => {
    const id = await seed("normalization", "Structuring tables to reduce redundancy.");
    // Deliberately unrelated sense, so the vector arm cannot be what surfaces it.
    const hits = await search("normalisation", "Something else entirely, unrelated wording.");
    const hit = hits.find((h) => h.conceptId === id);
    expect(hit, "lexical arm should surface a near-miss spelling").toBeDefined();
    expect(hit?.arms).toContain("lexical");
    expect(hit?.lexicalScore).toBeGreaterThan(0.5);
  });

  it("finds a synonym with no shared wording through the graph-local arm", async () => {
    // The case cosine similarity cannot solve: same concept, no shared wording.
    const promises = await seed("promises", "A value that settles later.");
    const eventLoop = await seed(
      "the event loop",
      "Queue-and-turn scheduling of deferred work by the runtime.",
    );
    await proposeEdge(prisma, {
      srcId: eventLoop, dstId: promises, type: "prerequisite_of", strength: "hard",
      failureMode: "The learner predicts a zero-delay timer fires before the current function returns.",
    });

    // Proposed while expanding `promises`, so `promises` is the expected neighbour.
    const hits = await search(
      "JS concurrency model",
      "How deferred work is ordered at runtime.",
      [promises],
    );

    const hit = hits.find((h) => h.conceptId === eventLoop);
    expect(hit, "graph-local arm should surface a neighbour of the expansion target").toBeDefined();
    expect(hit?.arms).toContain("graph");
    expect(hit?.neighborhoodOverlap).toBeGreaterThan(0);
    // And it is genuinely invisible to the other two arms.
    expect(hit?.arms).not.toContain("lexical");
  });

  it("scores neighborhood overlap as a fraction of the expected set", async () => {
    const a = await seed("functions", "A named, reusable unit of computation.");
    const b = await seed("scope", "The region where a binding is visible.");
    const target = await seed("closures", "A function plus its captured scope.");
    for (const [src, fm] of [
      [a, "The learner treats a returned inner function as already executed."],
      [b, "The learner expects a captured variable to hold its value at definition time."],
    ] as const) {
      await proposeEdge(prisma, {
        srcId: src, dstId: target, type: "prerequisite_of", strength: "hard", failureMode: fm,
      });
    }

    // `closures` neighbours both expected concepts → overlap 2/2.
    const both = await search("lexical closure", "Unrelated wording here.", [a, b]);
    expect(both.find((h) => h.conceptId === target)?.neighborhoodOverlap).toBeCloseTo(1, 5);

    // Only one of three expected concepts is a neighbour → 1/3.
    const partial = await search("lexical closure", "Unrelated wording here.", [a, "nope", "also-nope"]);
    expect(partial.find((h) => h.conceptId === target)?.neighborhoodOverlap).toBeCloseTo(1 / 3, 5);
  });

  it("excludes deprecated concepts", async () => {
    const id = await seed("closures", "A function together with the scope it captured.");
    await prisma.concept.update({ where: { id }, data: { deprecatedAt: new Date() } });
    const hits = await search("closures", "A function together with the scope it captured.");
    expect(hits.find((h) => h.conceptId === id)).toBeUndefined();
  });
});
