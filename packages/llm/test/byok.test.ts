import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ByokConfigError,
  LLMAuthError,
  OpenAICompatibleLLM,
  assertPublicHttpsUrl,
  listModels,
  parseLlmConfig,
  providerFromConfig,
  resolveLlm,
  type Lookup,
} from "../src/index.js";

const KEY = "sk-secret-key-12345";
const cfg = { provider: "openai", apiKey: KEY, small: "gpt-4o-mini", strong: "gpt-4o" };
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const lookupTo = (...addrs: string[]): Lookup => async () =>
  addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("parseLlmConfig", () => {
  it("round-trips a valid header", () => {
    expect(parseLlmConfig(encode(cfg))).toEqual(cfg);
  });

  it("rejects non-base64, non-JSON and oversized headers", () => {
    expect(() => parseLlmConfig("!!!")).toThrow(ByokConfigError);
    expect(() => parseLlmConfig(Buffer.from("not json").toString("base64"))).toThrow(ByokConfigError);
    expect(() => parseLlmConfig("A".repeat(5000))).toThrow(/too large/);
  });

  it("requires a base URL for custom", () => {
    expect(() => parseLlmConfig(encode({ ...cfg, provider: "custom" }))).toThrow(/baseUrl/);
  });

  it("rejects a key with whitespace without echoing it", () => {
    const bad = { ...cfg, apiKey: "sk secret key 12345" };
    expect(() => parseLlmConfig(encode(bad))).toThrow(ByokConfigError);
    try {
      parseLlmConfig(encode(bad));
    } catch (err) {
      expect((err as Error).message).not.toContain("secret");
      expect((err as Error).message).toContain("apiKey");
    }
  });
});

describe("assertPublicHttpsUrl", () => {
  const pub = lookupTo("93.184.216.34");

  it.each([
    ["http", "http://example.com/v1"],
    ["IPv4 literal", "https://127.0.0.1/v1"],
    ["IPv6 literal", "https://[::1]/v1"],
    ["metadata IP", "https://169.254.169.254/v1"],
    ["decimal IP", "https://2130706433/v1"],
    ["credentials", "https://user:pw@example.com/v1"],
    ["query", "https://example.com/v1?x=1"],
  ])("rejects %s", async (_name, url) => {
    await expect(assertPublicHttpsUrl(url, pub)).rejects.toThrow(ByokConfigError);
  });

  it.each([
    ["private IPv4", ["10.0.0.5"]],
    ["mapped loopback", ["::ffff:127.0.0.1"]],
    ["public plus private", ["93.184.216.34", "192.168.1.1"]],
    ["unique-local IPv6", ["fd00::1"]],
  ])("rejects a host resolving to %s", async (_name, addrs) => {
    await expect(assertPublicHttpsUrl("https://example.com/v1", lookupTo(...addrs))).rejects.toThrow(
      /private or reserved/,
    );
  });

  it("accepts a public host and strips the trailing slash", async () => {
    await expect(assertPublicHttpsUrl("https://example.com/v1/", pub)).resolves.toBe("https://example.com/v1");
  });
});

describe("resolveLlm", () => {
  it("uses the fallback only when no header is sent", async () => {
    const fallback = vi.fn(() => null);
    await expect(resolveLlm(undefined, fallback)).resolves.toBeNull();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("builds a provider on the fixed base URL even with LLM_BASE_URL set", async () => {
    vi.stubEnv("LLM_BASE_URL", "https://owner.example/v1");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const fallback = vi.fn(() => null);
    const llm = await resolveLlm(encode(cfg), fallback);
    expect(fallback).not.toHaveBeenCalled();
    expect(llm?.onUsage).toBeUndefined();
    await llm?.complete({ system: "s", user: "u", tier: "small" });
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("throws on a bad header without calling the fallback", async () => {
    const fallback = vi.fn(() => null);
    await expect(resolveLlm("garbage", fallback)).rejects.toThrow(ByokConfigError);
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe("provider hardening", () => {
  const llm = new OpenAICompatibleLLM({ apiKey: KEY, models: { small: "gpt-4o-mini", strong: "o3-mini" } });

  it("turns a 401 into LLMAuthError without the key or body", async () => {
    vi.stubGlobal("fetch", async () => new Response(`bad key ${KEY}`, { status: 401 }));
    const err = await llm.complete({ system: "s", user: "u", tier: "small" }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMAuthError);
    expect(err.message).not.toContain(KEY);
  });

  it("cuts and redacts other error bodies", async () => {
    vi.stubGlobal("fetch", async () => new Response(`${KEY} ${"x".repeat(1000)}`, { status: 500 }));
    const err = await llm.complete({ system: "s", user: "u", tier: "small" }).catch((e) => e);
    expect(err.message).not.toContain(KEY);
    expect(err.message.length).toBeLessThan(400);
  });

  it("sends max_completion_tokens and no temperature to reasoning models", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await llm.complete({ system: "s", user: "u", tier: "strong" });
    await llm.complete({ system: "s", user: "u", tier: "small" });
    const [reasoning, plain] = fetchMock.mock.calls.map((c) =>
      JSON.parse(((c as unknown[])[1] as { body: string }).body),
    );
    expect(reasoning).toMatchObject({ max_completion_tokens: 2048 });
    expect(reasoning).not.toHaveProperty("temperature");
    expect(plain).toMatchObject({ max_tokens: 2048, temperature: 0 });
  });
});

describe("listModels", () => {
  it("returns sorted unique ids and uses Anthropic headers", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, {}] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(listModels({ provider: "anthropic", apiKey: KEY })).resolves.toEqual(["a", "b"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
  });

  it("maps 404 to a base-URL hint and never reaches a private custom host", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    await expect(listModels({ provider: "openai", apiKey: KEY })).rejects.toThrow(/\/v1 root/);
    await expect(
      listModels({ provider: "custom", apiKey: KEY, baseUrl: "https://example.com/v1" }, lookupTo("10.0.0.1")),
    ).rejects.toThrow(ByokConfigError);
  });

  it("builds a custom provider only after the guard passes", async () => {
    const custom = { ...cfg, provider: "custom" as const, baseUrl: "https://example.com/v1/" };
    await expect(providerFromConfig(custom, lookupTo("10.0.0.1"))).rejects.toThrow(ByokConfigError);
    await expect(providerFromConfig(custom, lookupTo("93.184.216.34"))).resolves.toBeDefined();
  });
});
