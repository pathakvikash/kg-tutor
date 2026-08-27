import type { ResolverVerdict } from "@kg/shared";

export interface LabelledPair {
  id: string;
  proposed: { name: string; sense: string };
  existing: { name: string; sense: string };
  expected: ResolverVerdict;
  /** Why this pair is here — what mistake it is designed to catch. */
  tests: string;
}

/** Chosen adversarially, not representatively: easy pairs are not what corrupts a graph. */
export const PAIRS: LabelledPair[] = [
  // true synonyms: different words, same concept
  {
    id: "synonym-event-loop",
    proposed: { name: "JavaScript concurrency model", sense: "Queue-and-turn scheduling of deferred work by the runtime." },
    existing: { name: "the event loop", sense: "The runtime's mechanism for scheduling deferred work in turns." },
    expected: "same",
    tests: "a genuine synonym sharing no wording — embeddings alone will rank these apart",
  },
  {
    id: "synonym-normalisation",
    proposed: { name: "database normalisation", sense: "Structuring relational tables to reduce redundancy." },
    existing: { name: "normalization", sense: "Organising relational tables to eliminate redundant data." },
    expected: "same",
    tests: "spelling variant of the same concept",
  },

  // near-misses: very close, genuinely different
  {
    id: "near-promises-async",
    proposed: { name: "async/await", sense: "Syntax for writing promise-based code in a sequential style." },
    existing: { name: "promises", sense: "An object representing a value that will settle later." },
    expected: "related",
    tests: "extremely close in embedding space, masterable independently — a false `same` here merges two teachable concepts",
  },
  {
    id: "near-recursion-iteration",
    proposed: { name: "iteration", sense: "Repeating a computation with a loop construct." },
    existing: { name: "recursion", sense: "A function defined in terms of calls to itself." },
    expected: "related",
    tests: "conceptual siblings that a model may call `same` because they solve similar problems",
  },
  {
    id: "near-authn-authz",
    proposed: { name: "authorization", sense: "Deciding what an identified principal is permitted to do." },
    existing: { name: "authentication", sense: "Establishing who a principal is." },
    expected: "related",
    tests: "routinely conflated by humans and models alike",
  },

  // homonyms: same name, different field, and a false `same` is unrecoverable
  {
    id: "homonym-model-ml-mvc",
    proposed: { name: "Model", sense: "The data and business-logic layer in the MVC pattern." },
    existing: { name: "Model", sense: "A function fitted to data that makes predictions." },
    expected: "distinct",
    tests: "identical names, unrelated meanings — the case the sense field exists for",
  },
  {
    id: "homonym-normalization-stats",
    proposed: { name: "normalization", sense: "Rescaling numeric features to a common range." },
    existing: { name: "normalization", sense: "Organising relational tables to eliminate redundant data." },
    expected: "distinct",
    tests: "same name, same word, different discipline",
  },
  {
    id: "homonym-function",
    proposed: { name: "function", sense: "A mapping from each element of a domain to exactly one element of a codomain." },
    existing: { name: "function", sense: "A named, reusable unit of computation in a program." },
    expected: "distinct",
    tests: "mathematics versus programming",
  },

  // subsumption: the verdict a binary same/different cannot express
  {
    id: "subsume-flexbox",
    proposed: { name: "Flexbox", sense: "A one-dimensional CSS layout algorithm." },
    existing: { name: "CSS layout", sense: "How boxes are positioned and sized on a page." },
    expected: "narrower",
    tests: "a part being proposed against its whole",
  },
  {
    id: "subsume-gradient-descent",
    proposed: { name: "optimization", sense: "Finding parameters that minimise an objective." },
    existing: { name: "gradient descent", sense: "Iteratively stepping parameters against the gradient." },
    expected: "broader",
    tests: "a whole being proposed against its part — the mirror case",
  },
  {
    id: "subsume-http-caching",
    proposed: { name: "HTTP caching", sense: "Reusing stored responses according to HTTP cache headers." },
    existing: { name: "HTTP", sense: "The request-response protocol underlying the web." },
    expected: "narrower",
    tests: "a sub-topic that a model may call `same` because one name contains the other",
  },

  // genuinely unrelated
  {
    id: "distinct-unrelated",
    proposed: { name: "photosynthesis", sense: "How plants convert light into chemical energy." },
    existing: { name: "closures", sense: "A function together with the scope it captured." },
    expected: "distinct",
    tests: "sanity check — nothing in common",
  },
];
