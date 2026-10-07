import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { proposeConcept, proposeEdge } from "../src/resolve.js";
import { prisma, reset, deps, alwaysDistinct, ScriptedAdjudicator } from "./helpers.js";

const FM_A = "The learner reads an inner function as running immediately rather than being returned.";
const FM_B = "The learner writes a cache recreated on every call, so nothing is ever reused.";

async function seed(name: string, sense: string) {
  const r = await proposeConcept(deps(alwaysDistinct), { name, sense });
  return r.conceptId;
}

beforeEach(reset);
afterAll(async () => { await prisma.$disconnect(); });

describe("proposeConcept", () => {
  it("creates a concept, its alias, and its identity vector", async () => {
    const r = await proposeConcept(deps(alwaysDistinct), {
      name: "Closures",
      sense: "A function together with the scope it captured.",
    });
    expect(r.outcome).toBe("created");

    const [row] = await prisma.$queryRawUnsafe<{ has_vector: boolean }[]>(
      `SELECT "senseVector" IS NOT NULL AS has_vector FROM "Concept" WHERE id = $1`,
      r.conceptId,
    );
    expect(row?.has_vector).toBe(true);

    const alias = await prisma.conceptAlias.findUnique({ where: { name: "closures" } });
    expect(alias?.conceptId).toBe(r.conceptId);
  });

  it("aliases instead of creating on a `same` verdict", async () => {
    const id = await seed("the event loop", "The runtime's queue-and-turn scheduling model.");
    const same = new ScriptedAdjudicator(() => ({
      verdict: "same",
      relatedConceptId: id,
      reasoning: "scripted",
    }));

    const r = await proposeConcept(deps(same), {
      name: "JavaScript concurrency model",
      sense: "The runtime's queue-and-turn scheduling model.",
    });

    expect(r.outcome).toBe("bound");
    expect(r.conceptId).toBe(id);
    expect(await prisma.concept.count()).toBe(1);
    expect(await prisma.conceptAlias.count({ where: { conceptId: id } })).toBe(2);
  });

  it("creates with a `contains` edge on subsumption rather than merging", async () => {
    const broad = await seed("CSS layout", "How boxes are placed and sized on a page.");
    const narrower = new ScriptedAdjudicator(() => ({
      verdict: "narrower",
      relatedConceptId: broad,
      reasoning: "scripted",
    }));

    const r = await proposeConcept(deps(narrower), {
      name: "Flexbox",
      sense: "A one-dimensional CSS layout algorithm.",
    });

    expect(r.outcome).toBe("created");
    expect(r.edgeId).toBeTruthy();
    const edge = await prisma.edge.findUniqueOrThrow({ where: { id: r.edgeId! } });
    expect(edge.type).toBe("contains");
    expect(edge.srcId).toBe(broad);
    expect(edge.dstId).toBe(r.conceptId);
  });

  it("downgrades a hallucinated concept id to distinct rather than binding to it", async () => {
    await seed("recursion", "A function defined in terms of itself.");
    const liar = new ScriptedAdjudicator(() => ({
      verdict: "same",
      relatedConceptId: "id-that-was-never-offered",
      reasoning: "scripted",
    }));

    const { validateDecision } = await import("../src/adjudicate.js");
    const { decision, downgraded } = validateDecision(
      await liar.adjudicate({
        proposedName: "recursion",
        proposedSense: "x",
        candidates: [{
          conceptId: "real-id", canonicalName: "recursion", sense: "y",
          vectorScore: 1, lexicalScore: 1, neighborhoodOverlap: 1,
        }],
      }),
      [{
        conceptId: "real-id", canonicalName: "recursion", sense: "y",
        vectorScore: 1, lexicalScore: 1, neighborhoodOverlap: 1,
      }],
    );
    expect(downgraded).toBe(true);
    expect(decision.verdict).toBe("distinct");
  });

  it("records every proposal, including ones that bound to something existing", async () => {
    const id = await seed("promises", "A value that will settle later.");
    const same = new ScriptedAdjudicator(() => ({
      verdict: "same", relatedConceptId: id, reasoning: "scripted",
    }));
    await proposeConcept(deps(same), { name: "thenables", sense: "A value that will settle later." });

    const proposals = await prisma.conceptProposal.findMany({ orderBy: { createdAt: "asc" } });
    expect(proposals).toHaveLength(2);
    expect(proposals.every((p) => p.resolvedToId !== null)).toBe(true);
    expect(proposals[1]?.verdict).toBe("same");
  });

  it("serializes concurrent proposals of the same name into one concept", async () => {
    const results = await Promise.all([
      proposeConcept(deps(alwaysDistinct), { name: "Python", sense: "A general-purpose language." }),
      proposeConcept(deps(alwaysDistinct), { name: "Python", sense: "A general-purpose language." }),
    ]);
    expect(await prisma.concept.count()).toBe(1);
    expect(new Set(results.map((r) => r.conceptId)).size).toBe(1);
    expect(results.map((r) => r.outcome).sort()).toEqual(["bound", "created"]);
  });
});

describe("proposeEdge", () => {
  it("writes a hard edge when the failure mode is concrete", async () => {
    const a = await seed("functions", "A named, reusable unit of computation.");
    const b = await seed("closures", "A function together with the scope it captured.");
    const r = await proposeEdge(prisma, {
      srcId: a, dstId: b, type: "prerequisite_of", strength: "hard", failureMode: FM_A,
    });
    expect(r).toMatchObject({ strength: "hard", demoted: false });
    expect(r.edgeId).toBeTruthy();
  });

  it("demotes to soft rather than dropping the edge when the failure mode is empty talk", async () => {
    const a = await seed("functions", "A named, reusable unit of computation.");
    const b = await seed("closures", "A function together with the scope it captured.");
    const r = await proposeEdge(prisma, {
      srcId: a, dstId: b, type: "prerequisite_of", strength: "hard",
      failureMode: "The learner will not fully understand closures without it.",
    });
    expect(r).toMatchObject({ strength: "soft", demoted: true });
    const edge = await prisma.edge.findUniqueOrThrow({ where: { id: r.edgeId! } });
    expect(edge.failureMode).toBeNull();
  });

  it("reports a cycle instead of throwing, so the caller can route it to review", async () => {
    const a = await seed("functions", "A named, reusable unit of computation.");
    const b = await seed("closures", "A function together with the scope it captured.");
    const c = await seed("memoization", "Caching results by argument.");
    const hard = (srcId: string, dstId: string, failureMode: string) =>
      proposeEdge(prisma, { srcId, dstId, type: "prerequisite_of", strength: "hard", failureMode });

    await hard(a, b, FM_A);
    await hard(b, c, FM_B);
    const closing = await hard(c, a, "The learner defines a helper that calls itself with no base case.");

    expect(closing.rejected).toBe("cycle");
    expect(closing.edgeId).toBeNull();
    expect(await prisma.edge.count()).toBe(2);
  });

  it("allows a soft edge to close the same cycle", async () => {
    const a = await seed("functions", "A named, reusable unit of computation.");
    const b = await seed("closures", "A function together with the scope it captured.");
    await proposeEdge(prisma, {
      srcId: a, dstId: b, type: "prerequisite_of", strength: "hard", failureMode: FM_A,
    });
    const soft = await proposeEdge(prisma, {
      srcId: b, dstId: a, type: "related_to", strength: "soft",
    });
    expect(soft.edgeId).toBeTruthy();
    expect(soft.rejected).toBeUndefined();
  });
});
