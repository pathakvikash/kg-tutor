import { describe, it, expect } from "vitest";
import { z } from "zod";
import { extractJson, completeJson, LLMError, ScriptedLLM } from "../src/index.js";

describe("extractJson", () => {
  it("parses bare JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("unwraps fenced JSON", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n[1,2]\n```')).toEqual([1, 2]);
  });

  it("finds an object buried in prose", () => {
    expect(extractJson('Sure! Here you go:\n{"verdict":"same"}\nHope that helps.'))
      .toEqual({ verdict: "same" });
  });

  it("is not fooled by braces inside strings", () => {
    expect(extractJson('{"reasoning":"use } carefully","ok":true}'))
      .toEqual({ reasoning: "use } carefully", ok: true });
  });

  it("handles nesting", () => {
    expect(extractJson('noise {"a":{"b":[1,{"c":2}]}} more'))
      .toEqual({ a: { b: [1, { c: 2 }] } });
  });

  it("throws when there is no JSON at all", () => {
    expect(() => extractJson("I cannot help with that.")).toThrow(LLMError);
  });
});

describe("completeJson", () => {
  const schema = z.object({ verdict: z.string() });

  it("returns the parsed value on a clean first response", async () => {
    const llm = new ScriptedLLM(() => '{"verdict":"same"}');
    expect(await completeJson(llm, { system: "s", user: "u", tier: "small" }, schema))
      .toEqual({ verdict: "same" });
    expect(llm.calls).toHaveLength(1);
  });

  it("retries once with the validation error fed back", async () => {
    const llm = new ScriptedLLM((_req, i) => (i === 0 ? '{"wrong":1}' : '{"verdict":"distinct"}'));
    const out = await completeJson(llm, { system: "s", user: "u", tier: "small" }, schema);
    expect(out).toEqual({ verdict: "distinct" });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.user).toContain("could not be used");
  });

  it("gives up after the retry rather than accepting malformed structure", async () => {
    const llm = new ScriptedLLM(() => "nope");
    await expect(
      completeJson(llm, { system: "s", user: "u", tier: "small" }, schema),
    ).rejects.toThrow(LLMError);
    expect(llm.calls).toHaveLength(2);
  });
});

describe("llmFromEnv", () => {
  it("returns null with no key, rather than a mock that fabricates graph content", async () => {
    const { llmFromEnv } = await import("../src/providers.js");
    expect(llmFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("prefers Anthropic when both keys are present", async () => {
    const { llmFromEnv } = await import("../src/providers.js");
    const p = llmFromEnv({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b" } as NodeJS.ProcessEnv);
    expect(p?.name).toContain("anthropic");
  });
});

describe("arrayOrWrapped", () => {
  it("accepts the wrapper object", async () => {
    const { arrayOrWrapped } = await import("../src/provider.js");
    const schema = arrayOrWrapped("items", z.object({ a: z.number() }));
    expect(schema.parse({ items: [{ a: 1 }] })).toEqual({ items: [{ a: 1 }] });
  });

  it("accepts a bare array, which is what models actually return", async () => {
    const { arrayOrWrapped } = await import("../src/provider.js");
    const schema = arrayOrWrapped("items", z.object({ a: z.number() }));
    // Strictness here bought nothing and cost a 500 halfway through an intake.
    expect(schema.parse([{ a: 1 }, { a: 2 }])).toEqual({ items: [{ a: 1 }, { a: 2 }] });
  });

  it("still rejects genuinely wrong shapes", async () => {
    const { arrayOrWrapped } = await import("../src/provider.js");
    const schema = arrayOrWrapped("items", z.object({ a: z.number() }));
    expect(() => schema.parse([{ a: "not a number" }])).toThrow();
    expect(() => schema.parse({ wrong: [] })).toThrow();
  });
});
