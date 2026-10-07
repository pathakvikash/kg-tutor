import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { ScriptedLLM } from "@kg/llm";
import { decideAction, runAttempt, type AttemptContext } from "../src/attempt.js";
import { GRADE_SYSTEM_PROMPT } from "../src/grade.js";
import { prisma, reset, concept, learner, hardEdge } from "./helpers.js";
import type { GradeResult } from "../src/grade.js";

const FM = "The learner predicts a zero-delay timer runs before the current function returns.";

const grade = (over: Partial<GradeResult> = {}): GradeResult => ({
  correct: false, diagnosis: "cannot_apply", matchedEdgeId: null,
  belief: null, restatementOnly: false, reasoning: "", ...over,
});

const ctx = (over: Partial<AttemptContext> = {}): AttemptContext => ({
  learnerId: "l", conceptId: "c", reexplanationsUsed: 0,
  detoursUsedInChain: 0, detourDepth: 0, ...over,
});

const prereq = { conceptId: "p", name: "the event loop" };

beforeEach(reset);
afterAll(async () => { await prisma.$disconnect(); });

describe("decideAction", () => {
  it("advances on a correct answer", () => {
    expect(decideAction(grade({ correct: true }), ctx(), prereq).kind).toBe("advance");
  });

  it("re-asks a careless slip rather than detouring", () => {
    expect(decideAction(grade({ diagnosis: "careless" }), ctx(), prereq).kind).toBe("reask");
  });

  it("corrects a misconception directly instead of re-teaching", () => {
    const a = decideAction(
      grade({ diagnosis: "misconception", belief: "timers run immediately", matchedEdgeId: "e1" }),
      ctx(), prereq,
    );
    expect(a).toEqual({ kind: "correct_misconception", belief: "timers run immediately", edgeId: "e1" });
  });

  it("detours on a prerequisite gap", () => {
    const a = decideAction(grade({ diagnosis: "missing_prerequisite" }), ctx(), prereq);
    expect(a).toEqual({
      kind: "detour", prerequisiteConceptId: "p", prerequisiteName: "the event loop",
    });
  });

  it("re-explains when the learner understands but cannot apply", () => {
    expect(decideAction(grade({ diagnosis: "cannot_apply" }), ctx(), prereq).kind).toBe("reexplain");
  });

  it("blocks rather than descending past the depth bound", () => {
    const a = decideAction(
      grade({ diagnosis: "missing_prerequisite" }), ctx({ detourDepth: 2 }), prereq,
    );
    expect(a.kind).toBe("block");
  });

  it("blocks once the chain's detour budget is spent this session", () => {
    const a = decideAction(
      grade({ diagnosis: "missing_prerequisite" }), ctx({ detoursUsedInChain: 1 }), prereq,
    );
    expect(a.kind).toBe("block");
  });

  it("blocks after the re-explanation budget rather than looping", () => {
    const a = decideAction(grade({ diagnosis: "cannot_apply" }), ctx({ reexplanationsUsed: 2 }), prereq);
    expect(a.kind).toBe("block");
  });
});

describe("runAttempt", () => {
  async function fixture() {
    const l = await learner();
    const eventLoop = await concept("the event loop");
    const promises = await concept("promises");
    const edgeId = await hardEdge(eventLoop, promises, FM);
    return { l, eventLoop, promises, edgeId };
  }

  it("never shows the grader the explanation, and emits exactly one event", async () => {
    const f = await fixture();
    const llm = new ScriptedLLM(() => JSON.stringify({
      correct: true, diagnosis: "careless", matchedFailureModeIndex: null,
      belief: null, restatementOnly: false, reasoning: "applied correctly",
    }));

    const out = await runAttempt({
      prisma, llm, prompt: "Predict the output order.", response: "the log runs first",
      requiresTransfer: true,
      ctx: ctx({ learnerId: f.l, conceptId: f.promises }),
    });

    expect(out.evidenceKind).toBe("transferred");
    expect(out.state.after.mastery).toBe("solid");
    expect(await prisma.evidenceEvent.count({ where: { conceptId: f.promises } })).toBe(1);

    const prompts = llm.calls.map((c) => `${c.system}\n${c.user}`).join("\n");
    expect(prompts).toContain(GRADE_SYSTEM_PROMPT.slice(0, 40));
    expect(prompts.toLowerCase()).not.toContain("explanation the learner was shown");
    expect(prompts).toContain(FM);
  });

  it("records a restatement as `restated`, not as application", async () => {
    const f = await fixture();
    const llm = new ScriptedLLM(() => JSON.stringify({
      correct: true, diagnosis: "careless", matchedFailureModeIndex: null,
      belief: null, restatementOnly: true, reasoning: "just a definition",
    }));
    const out = await runAttempt({
      prisma, llm, prompt: "q", response: "a promise is a future value",
      requiresTransfer: true, ctx: ctx({ learnerId: f.l, conceptId: f.promises }),
    });
    expect(out.evidenceKind).toBe("restated");
    expect(out.state.after.mastery).toBe("familiar");
    expect(out.propagatedTo).toEqual([]);
  });

  it("stores a misconception and routes the detour to the matched prerequisite", async () => {
    const f = await fixture();
    const llm = new ScriptedLLM(() => JSON.stringify({
      correct: false, diagnosis: "misconception", matchedFailureModeIndex: 0,
      belief: "setTimeout with 0 runs immediately", restatementOnly: false, reasoning: "",
    }));
    const out = await runAttempt({
      prisma, llm, prompt: "q", response: "it logs second",
      requiresTransfer: false, ctx: ctx({ learnerId: f.l, conceptId: f.promises }),
    });

    expect(out.action.kind).toBe("correct_misconception");
    expect(out.grade.matchedEdgeId).toBe(f.edgeId);

    const stored = await prisma.misconception.findFirstOrThrow({ where: { conceptId: f.promises } });
    expect(stored.belief).toContain("runs immediately");
    expect(stored.matchedFailureMode).toBe(FM);
  });

  it("credits hard prerequisites on clean success", async () => {
    const f = await fixture();
    const llm = new ScriptedLLM(() => JSON.stringify({
      correct: true, diagnosis: "careless", matchedFailureModeIndex: null,
      belief: null, restatementOnly: false, reasoning: "",
    }));
    const out = await runAttempt({
      prisma, llm, prompt: "q", response: "correct", requiresTransfer: false,
      ctx: ctx({ learnerId: f.l, conceptId: f.promises }),
    });
    expect(out.propagatedTo).toEqual([f.eventLoop]);
    const upstream = await prisma.learnerConceptState.findFirstOrThrow({
      where: { conceptId: f.eventLoop },
    });
    expect(upstream.mastery).toBe("solid");
    expect(upstream.source).toBe("inferred");
  });

  it("updates item statistics so weak items can retire themselves", async () => {
    const f = await fixture();
    const item = await prisma.assessmentItem.create({
      data: { conceptId: f.promises, prompt: "q", rubric: {}, targetsLevel: "functional" },
    });
    const llm = new ScriptedLLM(() => JSON.stringify({
      correct: false, diagnosis: "cannot_apply", matchedFailureModeIndex: null,
      belief: null, restatementOnly: false, reasoning: "",
    }));
    await runAttempt({
      prisma, llm, prompt: "q", response: "no", requiresTransfer: false,
      ctx: ctx({ learnerId: f.l, conceptId: f.promises, itemId: item.id }),
    });
    const after = await prisma.assessmentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.timesUsed).toBe(1);
    expect(after.correctCount).toBe(0);
  });
});

describe("grading a correct answer", () => {
  it("accepts a null diagnosis, because the prompt asks for null when correct", async () => {
    const f = await (async () => {
      const l = await learner();
      const c = await concept("promises");
      return { l, c };
    })();
    const llm = new ScriptedLLM(() => JSON.stringify({
      correct: true, diagnosis: null, matchedFailureModeIndex: null,
      belief: null, restatementOnly: false, reasoning: "right, with the ordering explained",
    }));

    const out = await runAttempt({
      prisma, llm, prompt: "Predict the order.", response: "loop 0,1,2 then the timeouts",
      requiresTransfer: true, ctx: ctx({ learnerId: f.l, conceptId: f.c }),
    });

    expect(out.grade.correct).toBe(true);
    expect(out.evidenceKind).toBe("transferred");
    expect(out.action.kind).toBe("advance");
    expect(llm.calls).toHaveLength(1);
  });

  it("still requires a diagnosis when the answer is wrong", async () => {
    const l = await learner();
    const c = await concept("promises");
    const llm = new ScriptedLLM(() => JSON.stringify({
      correct: false, diagnosis: "cannot_apply", matchedFailureModeIndex: null,
      belief: null, restatementOnly: false, reasoning: "",
    }));
    const out = await runAttempt({
      prisma, llm, prompt: "q", response: "no", requiresTransfer: false,
      ctx: ctx({ learnerId: l, conceptId: c }),
    });
    expect(out.grade.diagnosis).toBe("cannot_apply");
    expect(out.action.kind).toBe("reexplain");
  });
});
