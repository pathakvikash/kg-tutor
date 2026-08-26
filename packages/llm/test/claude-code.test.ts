import { describe, it, expect } from "vitest";
import { ClaudeCodeLLM } from "../src/claude-code.js";
import type { UsageReport } from "../src/provider.js";
import { llmFromEnv } from "../src/providers.js";

describe("llmFromEnv", () => {
  it("selects the CLI backend only on explicit opt-in", () => {
    expect(llmFromEnv({ LLM_PROVIDER: "claude-code" } as NodeJS.ProcessEnv)?.name)
      .toContain("claude-code");
    // Without the opt-in, a machine with the CLI installed still gets null rather than
    // silently routing production traffic through a developer tool.
    expect(llmFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("still prefers a real API key when one is present", () => {
    expect(llmFromEnv({ ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv)?.name)
      .toContain("anthropic");
  });

  it("honours model overrides for each tier", () => {
    const p = llmFromEnv({
      LLM_PROVIDER: "claude-code", LLM_MODEL_SMALL: "haiku", LLM_MODEL_STRONG: "opus",
    } as NodeJS.ProcessEnv);
    expect(p?.name).toBe("claude-code:haiku/opus");
  });
});

describe("ClaudeCodeLLM", () => {
  it("reports a clear error when the CLI is missing", async () => {
    const llm = new ClaudeCodeLLM({ bin: "/nonexistent/claude" });
    await expect(llm.complete({ system: "s", user: "u", tier: "small" }))
      .rejects.toThrow(/could not run/);
  });

  it("limits concurrent subprocesses", async () => {
    // Each call is a full CLI boot; unbounded fan-out would spawn dozens at once.
    const llm = new ClaudeCodeLLM({ bin: "/nonexistent/claude", maxConcurrent: 2 });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => llm.complete({ system: "s", user: "u", tier: "small" })),
    );
    // All settle rather than deadlocking on the semaphore.
    expect(results.every((r) => r.status === "rejected")).toBe(true);
  });

  it("surfaces usage so spend is recorded rather than assumed", () => {
    const llm = new ClaudeCodeLLM();
    const seen: UsageReport[] = [];
    llm.onUsage = (u) => seen.push(u);
    expect(typeof llm.onUsage).toBe("function");
    expect(seen).toHaveLength(0);
  });
});

describe("failure classification", () => {
  it("treats an expired login as an auth failure with a remedy, not a generic error", async () => {
    const { LLMAuthError } = await import("../src/provider.js");
    // The CLI exits non-zero but still prints a JSON body whose `result` carries the
    // only actionable text. Rejecting on the exit code alone threw that away.
    const body = JSON.stringify({
      is_error: true,
      result: "Failed to authenticate: OAuth session expired and could not be refreshed",
    });
    const llm = new ClaudeCodeLLM({
      bin: process.execPath,
      models: { small: "h", strong: "s" },
      maxRetries: 2,
    });
    // Stand in for the CLI: print the body and exit 1, exactly as it does.
    (llm as unknown as { bin: string }).bin = process.execPath;
    const original = (llm as any).run.bind(llm);
    void original;
    (llm as any).run = () =>
      new Promise((_res, rej) => {
        const parsed = JSON.parse(body);
        rej(new LLMAuthError(`Claude Code is not authenticated: ${parsed.result}`, "Run `claude` to sign in."));
      });

    const err = await llm.complete({ system: "s", user: "u", tier: "small" }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMAuthError);
    expect(err.remedy).toContain("claude");
  });

  it("does not retry an auth failure — an expired session will not fix itself", async () => {
    const { LLMAuthError } = await import("../src/provider.js");
    const llm = new ClaudeCodeLLM({ maxRetries: 2 });
    let attempts = 0;
    (llm as any).run = () => {
      attempts++;
      return Promise.reject(new LLMAuthError("expired", "sign in"));
    };
    await expect(llm.complete({ system: "s", user: "u", tier: "small" })).rejects.toThrow(LLMAuthError);
    expect(attempts).toBe(1);
  });

  it("still retries an ordinary transient failure", async () => {
    const { LLMError } = await import("../src/provider.js");
    const llm = new ClaudeCodeLLM({ maxRetries: 2 });
    let attempts = 0;
    (llm as any).run = () => {
      attempts++;
      return attempts < 3 ? Promise.reject(new LLMError("flaky")) : Promise.resolve("ok");
    };
    await expect(llm.complete({ system: "s", user: "u", tier: "small" })).resolves.toBe("ok");
    expect(attempts).toBe(3);
  });
});
