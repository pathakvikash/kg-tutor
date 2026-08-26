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

describe("startStream", () => {
  it("begins immediately rather than waiting to be read", async () => {
    const { startStream } = await import("../src/provider.js");
    let started = false;
    const provider = {
      name: "eager-probe",
      complete: async () => "",
      async *stream() { started = true; yield "a"; yield "b"; },
    };

    const s = startStream(provider, { system: "s", user: "u", tier: "small" });
    // The whole point. An async generator is lazy: kicking one off "in parallel" with
    // another await does not overlap anything, it just starts the call late.
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toBe(true);

    const out: string[] = [];
    for await (const c of s.chunks) out.push(c);
    expect(out).toEqual(["a", "b"]);
  });

  it("buffers what arrives before anyone reads", async () => {
    const { startStream } = await import("../src/provider.js");
    const provider = {
      name: "p", complete: async () => "",
      async *stream() { yield "one"; yield "two"; yield "three"; },
    };
    const s = startStream(provider, { system: "s", user: "u", tier: "small" });
    await new Promise((r) => setTimeout(r, 5));
    const out: string[] = [];
    for await (const c of s.chunks) out.push(c);
    expect(out).toEqual(["one", "two", "three"]);
  });

  it("surfaces a failure to the reader", async () => {
    const { startStream } = await import("../src/provider.js");
    const provider = {
      name: "p", complete: async () => "",
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<string> { throw new Error("upstream died"); },
    };
    const s = startStream(provider, { system: "s", user: "u", tier: "small" });
    await expect((async () => { for await (const _ of s.chunks) { /* drain */ } })())
      .rejects.toThrow("upstream died");
  });

  it("stops consuming once cancelled, so an abandoned answer is not paid for in full", async () => {
    const { startStream } = await import("../src/provider.js");
    let produced = 0;
    const provider = {
      name: "p", complete: async () => "",
      async *stream() {
        for (let i = 0; i < 50; i++) {
          produced++;
          yield String(i);
          await new Promise((r) => setTimeout(r, 1));
        }
      },
    };
    const s = startStream(provider, { system: "s", user: "u", tier: "small" });
    await new Promise((r) => setTimeout(r, 8));
    s.cancel();
    const atCancel = produced;
    await new Promise((r) => setTimeout(r, 25));
    expect(produced).toBeLessThan(atCancel + 3);
    expect(produced).toBeLessThan(50);
  });

  it("falls back to one chunk when the provider cannot stream", async () => {
    const { startStream } = await import("../src/provider.js");
    const provider = { name: "p", complete: async () => "whole answer" };
    const s = startStream(provider, { system: "s", user: "u", tier: "small" });
    const out: string[] = [];
    for await (const c of s.chunks) out.push(c);
    expect(out).toEqual(["whole answer"]);
  });
});
