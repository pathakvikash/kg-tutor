import { describe, it, expect } from "vitest";
import type { CompletionRequest, LLMProvider } from "@kg/llm";
import { gradeResponse } from "../src/grade.js";

/**
 * The grader receives the item's code, not just its prompt.
 *
 * Items store code in its own field so it renders as a block instead of one joined line.
 * The grading path never reassembled the two, so a question about four functions reached
 * the grader with no functions in it — and the grader said exactly that: "I cannot see
 * the functions a, b, c, and d". A learner who had answered correctly was recorded as a
 * failed check.
 */
describe("gradeResponse", () => {
  /** Records exactly what the grader was asked, which is the thing under test. */
  const capture = () => {
    const seen: string[] = [];
    const llm: LLMProvider = {
      name: "capture",
      complete: async (req: CompletionRequest) => {
        seen.push(req.user);
        return '{"correct":true,"diagnosis":null,"matchedFailureModeIndex":null,' +
          '"belief":null,"restatementOnly":false,"reasoning":"ok"}';
      },
    };
    return { llm, seen };
  };

  const base = {
    response: "b and c are higher-order.",
    conceptName: "higher-order functions",
    requiresTransfer: false,
    failureModes: [],
  };

  it("puts the snippet in the prompt it sends", async () => {
    const { llm, seen } = capture();
    await gradeResponse(llm, {
      ...base,
      prompt: "For each function below, say whether it is higher-order.",
      code: "function a(x) {\n  return x + 1;\n}\n\nfunction b(fn) {\n  return fn(5);\n}",
      codeLanguage: "javascript",
    });
    expect(seen[0]).toContain("function b(fn)");
    expect(seen[0]).toContain("return fn(5)");
    expect(seen[0]).toContain("javascript");
  });

  it("keeps the snippet's line breaks, so it is readable as code", async () => {
    const { llm, seen } = capture();
    await gradeResponse(llm, { ...base, prompt: "Predict the output.", code: "let x = 1;\nlet y = 2;" });
    expect(seen[0]).toContain("let x = 1;\nlet y = 2;");
  });

  it("says nothing about code when the item has none", async () => {
    const { llm, seen } = capture();
    await gradeResponse(llm, { ...base, prompt: "Define a closure in your own words." });
    expect(seen[0]).not.toMatch(/the code the question refers to/i);
  });
});
