/**
 * Seeds a small, real JavaScript graph through the resolver — same write path as a live
 * expansion, so nothing here bypasses dedup, the failure-mode rule or acyclicity.
 *
 * Exists because the UI is unusable against an empty database, and no model key is
 * configured on this machine. The concepts and failure modes are hand-written, not
 * generated: they are seed data, not evidence of what a model would produce.
 *
 *   pnpm --filter @kg/api seed
 */
import { db } from "@kg/db";
import { DeterministicEmbedding, proposeConcept, proposeEdge } from "@kg/graph";
import type { Adjudicator } from "@kg/graph";
import { recordEvidence } from "@kg/teach";

const prisma = db();

// Everything seeded is deliberately distinct; dedup is exercised by its own tests.
const adjudicator: Adjudicator = {
  name: "seed",
  async adjudicate() {
    return { verdict: "distinct", relatedConceptId: null, reasoning: "seed data" };
  },
};
const deps = { prisma, embedding: new DeterministicEmbedding(), adjudicator };

const CONCEPTS: [string, string][] = [
  ["variables", "A named binding holding a value that can be read and reassigned."],
  ["functions", "A named, reusable unit of computation that takes arguments and returns a value."],
  ["scope", "The region of a program where a binding is visible."],
  ["closures", "A function together with the scope it captured when it was defined."],
  ["higher-order functions", "A function that takes or returns another function."],
  ["the call stack", "The runtime's record of which function calls are in progress."],
  ["the event loop", "The runtime's mechanism for scheduling deferred work in turns."],
  ["callbacks", "A function passed to another function to be invoked later."],
  ["promises", "An object representing a value that will settle at some later point."],
  ["async/await", "Syntax for writing promise-based code in a sequential style."],
  ["memoization", "Caching a function's results by its arguments to avoid recomputation."],
  ["the DOM", "The tree of objects a browser exposes for the current document."],
  ["event handling", "Registering functions to run when the browser reports an interaction."],
  ["fetch and HTTP requests", "Asking a server for data over HTTP from within a page."],
  ["JSON", "A text format for representing structured data as objects and arrays."],
  ["error handling", "Detecting failures and responding to them rather than crashing."],
];

/** [prerequisite, target, strength, failure mode] — hard edges must name a real failure. */
const EDGES: [string, string, "hard" | "soft", string | null][] = [
  ["variables", "functions", "hard", "The learner writes a function body that references an argument it never declared."],
  ["variables", "scope", "hard", "The learner expects a binding declared inside a block to be readable outside it."],
  ["functions", "scope", "hard", "The learner cannot say which bindings a function body can see, so predicts the wrong value."],
  ["scope", "closures", "hard", "The learner expects a captured variable to hold the value it had when the function was defined."],
  ["functions", "closures", "hard", "The learner reads a returned inner function as having already run, and expects its result."],
  ["functions", "higher-order functions", "hard", "The learner passes the result of calling a function where the function itself was expected."],
  ["closures", "memoization", "hard", "The learner writes a cache that is recreated on every call, so nothing is ever reused."],
  ["higher-order functions", "callbacks", "hard", "The learner invokes the callback immediately instead of passing it to be called later."],
  ["functions", "the call stack", "hard", "The learner cannot explain why a deeply recursive function fails, blaming the algorithm."],
  ["the call stack", "the event loop", "hard", "The learner expects deferred work to interleave with the function that scheduled it."],
  ["the event loop", "promises", "hard", "The learner predicts a zero-delay timer runs before the current function returns."],
  ["callbacks", "promises", "hard", "The learner nests promise chains as if they were callbacks, losing the flat structure."],
  ["promises", "async/await", "hard", "The learner writes await outside an async function and expects it to block."],
  ["error handling", "async/await", "soft", null],
  ["the DOM", "event handling", "hard", "The learner attaches a handler before the element exists and cannot see why nothing fires."],
  ["callbacks", "event handling", "hard", "The learner calls the handler in the registration line, so it runs once and never again."],
  ["promises", "fetch and HTTP requests", "hard", "The learner reads the response object directly and finds a pending promise where data was expected."],
  ["JSON", "fetch and HTTP requests", "hard", "The learner treats the response body as an object and gets a string, or the reverse."],
  ["functions", "error handling", "soft", null],
  ["higher-order functions", "memoization", "soft", null],
];

const TOPICS: [string, string, string[]][] = [
  ["JavaScript Fundamentals", "Core language mechanics.",
    ["variables", "functions", "scope", "closures", "higher-order functions", "error handling"]],
  ["Asynchronous JavaScript", "How deferred work is ordered and written.",
    ["the call stack", "the event loop", "callbacks", "promises", "async/await"]],
  ["Frontend Web Development", "Building interactive pages in the browser.",
    ["the DOM", "event handling", "fetch and HTTP requests", "JSON"]],
];

const MILESTONES: [string, string, string[]][] = [
  ["JavaScript Fundamentals", "You can write and reason about functions that capture state",
    ["functions", "scope", "closures"]],
  ["Asynchronous JavaScript", "You can predict the order of asynchronous output",
    ["the event loop", "promises"]],
  ["Asynchronous JavaScript", "You can write async code that reads sequentially",
    ["promises", "async/await"]],
  ["Frontend Web Development", "You can fetch data and render it into the page",
    ["fetch and HTTP requests", "JSON", "the DOM"]],
];

async function main(): Promise<void> {
  const ids = new Map<string, string>();
  for (const [name, sense] of CONCEPTS) {
    const r = await proposeConcept(deps, { name, sense, context: "seed data" });
    ids.set(name, r.conceptId);
  }
  console.log(`concepts: ${ids.size}`);

  let hard = 0;
  let demoted = 0;
  let cycles = 0;
  for (const [src, dst, strength, failureMode] of EDGES) {
    const r = await proposeEdge(prisma, {
      srcId: ids.get(src)!, dstId: ids.get(dst)!,
      type: "prerequisite_of", strength, failureMode, confidence: 0.8,
    });
    if (r.rejected) cycles++;
    else if (r.strength === "hard") hard++;
    if (r.demoted) demoted++;
  }
  console.log(`edges: ${hard} hard, ${EDGES.length - hard - cycles} soft, ${demoted} demoted, ${cycles} rejected as cycles`);

  for (const [name, description, concepts] of TOPICS) {
    const topic = await prisma.topic.upsert({
      where: { name }, create: { name, description }, update: { description },
    });
    for (const c of concepts) {
      await prisma.topicConcept.upsert({
        where: { topicId_conceptId_relation: { topicId: topic.id, conceptId: ids.get(c)!, relation: "contains" } },
        create: { topicId: topic.id, conceptId: ids.get(c)!, direct: true, relevance: 0.8 },
        update: {},
      });
    }
  }

  for (const [topicName, claim, concepts] of MILESTONES) {
    const topic = await prisma.topic.findUniqueOrThrow({ where: { name: topicName } });
    const existing = await prisma.milestoneTemplate.findFirst({
      where: { topicId: topic.id, claim },
      include: { concepts: true },
    });
    // Re-seeding used to skip an existing template entirely, so a template whose
    // concepts had been cascaded away by a Concept delete stayed permanently empty.
    const t =
      existing ??
      (await prisma.milestoneTemplate.create({
        data: {
          topicId: topic.id,
          claim,
          ordering: await prisma.milestoneTemplate.count({ where: { topicId: topic.id } }),
          status: "canonical",
        },
      }));
    if (existing && existing.concepts.length === concepts.length) continue;

    await prisma.milestoneConcept.deleteMany({ where: { templateId: t.id } });
    for (const c of concepts) {
      const conceptId = ids.get(c);
      if (!conceptId) continue;
      await prisma.milestoneConcept.create({
        data: { templateId: t.id, conceptId, requiredLevel: "functional" },
      });
    }
  }
  console.log(`topics: ${TOPICS.length}, milestones: ${MILESTONES.length}`);

  // One learner partway through, so the path view has something real to show.
  const learner = await prisma.learner.upsert({
    where: { email: "demo@kg-tutor.test" },
    create: { email: "demo@kg-tutor.test", name: "Demo learner", background: "knows Python" },
    update: {},
  });
  for (const [name, kind] of [
    ["variables", "transferred"], ["functions", "applied"], ["scope", "applied"],
    ["the call stack", "restated"],
  ] as const) {
    await recordEvidence(prisma, { learnerId: learner.id, conceptId: ids.get(name)!, kind });
  }
  console.log(`learner: ${learner.email}`);
}

await main();
await prisma.$disconnect();
