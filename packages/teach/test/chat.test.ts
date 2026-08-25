import { describe, it, expect } from "vitest";
import { ScriptedLLM } from "@kg/llm";
import { routeChatQuestion, touchesLearnerModel } from "../src/chat.js";

const prerequisiteNames = [
  { conceptId: "cb", name: "callbacks" },
  { conceptId: "el", name: "the event loop" },
];

const route = (body: Record<string, unknown>) =>
  routeChatQuestion(new ScriptedLLM(() => JSON.stringify(body)), {
    question: "q",
    currentConceptName: "promises",
    prerequisiteNames,
  });

describe("routeChatQuestion", () => {
  it("pins a prerequisite gap to the named prerequisite", async () => {
    const r = await route({
      intent: "prerequisite_gap", prerequisiteIndex: 0,
      namedConcept: "callbacks", reasoning: "",
    });
    expect(r.intent).toBe("prerequisite_gap");
    expect(r.prerequisiteConceptId).toBe("cb");
  });

  it("keeps the named concept even when it is not a known prerequisite", async () => {
    // Still premium evidence — the learner named a gap the graph does not record. (19)
    const r = await route({
      intent: "prerequisite_gap", prerequisiteIndex: null,
      namedConcept: "microtask queue", reasoning: "",
    });
    expect(r.prerequisiteConceptId).toBeNull();
    expect(r.namedConcept).toBe("microtask queue");
  });

  it("ignores an out-of-range index rather than binding to the wrong concept", async () => {
    const r = await route({
      intent: "prerequisite_gap", prerequisiteIndex: 7, namedConcept: "x", reasoning: "",
    });
    expect(r.prerequisiteConceptId).toBeNull();
  });

  it("does not attach a prerequisite to a non-gap intent", async () => {
    const r = await route({
      intent: "tangential", prerequisiteIndex: 0, namedConcept: "useCallback", reasoning: "",
    });
    expect(r.intent).toBe("tangential");
    expect(r.prerequisiteConceptId).toBeNull();
  });

  it("classifies clarification and meta without inventing a concept", async () => {
    expect((await route({
      intent: "clarifies_current", prerequisiteIndex: null, namedConcept: null, reasoning: "",
    })).intent).toBe("clarifies_current");
    expect((await route({
      intent: "meta", prerequisiteIndex: null, namedConcept: null, reasoning: "",
    })).intent).toBe("meta");
  });
});

describe("touchesLearnerModel", () => {
  it("lets only the two subject-matter intents change what the system believes", () => {
    expect(touchesLearnerModel("prerequisite_gap")).toBe(true);
    expect(touchesLearnerModel("clarifies_current")).toBe(true);
    expect(touchesLearnerModel("tangential")).toBe(false);
    expect(touchesLearnerModel("meta")).toBe(false);
  });
});
