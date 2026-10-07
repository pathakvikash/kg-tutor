import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeLLM } from "../src/claude-code.js";
import type { UsageReport } from "../src/provider.js";
import { llmFromEnv } from "../src/providers.js";

describe("llmFromEnv", () => {
  it("selects the CLI backend only on explicit opt-in", () => {
    expect(llmFromEnv({ LLM_PROVIDER: "claude-code" } as NodeJS.ProcessEnv)?.name)
      .toContain("claude-code");
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
    const llm = new ClaudeCodeLLM({ bin: "/nonexistent/claude", maxConcurrent: 2 });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => llm.complete({ system: "s", user: "u", tier: "small" })),
    );
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
    const body = JSON.stringify({
      is_error: true,
      result: "Failed to authenticate: OAuth session expired and could not be refreshed",
    });
    const llm = new ClaudeCodeLLM({
      bin: process.execPath,
      models: { small: "h", strong: "s" },
      maxRetries: 2,
    });
    // Stand-in CLI: prints the body and exits 1
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

// Drives the real close handler through a real subprocess; a stubbed `run` cannot
describe("classification of a successful call", () => {
  /** A stand-in CLI that ignores its arguments and prints one fixed JSON body */
  function fakeCli(body: unknown, exitCode = 0): string {
    const dir = mkdtempSync(join(tmpdir(), "kg-cli-"));
    const path = join(dir, "claude");
    writeFileSync(path, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(body)}\nJSON\nexit ${exitCode}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("returns an answer about authentication instead of calling it an expired login", async () => {
    const llm = new ClaudeCodeLLM({
      bin: fakeCli({
        is_error: false,
        stop_reason: "end_turn",
        result: '{"verdict":"related","reasoning":"Authentication is who you are; OAuth login precedes authorization."}',
      }),
    });
    const out = await llm.complete({ system: "s", user: "u", tier: "small" });
    expect(out).toContain("Authentication");
  });

  it("still reports an expired login when the call actually failed", async () => {
    const { LLMAuthError } = await import("../src/provider.js");
    const llm = new ClaudeCodeLLM({
      maxRetries: 0,
      bin: fakeCli({ is_error: true, result: "OAuth token expired, please log in again" }, 1),
    });
    const err = await llm.complete({ system: "s", user: "u", tier: "small" }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMAuthError);
    expect(err.remedy).toContain("claude");
  });

  it("reports a tool call as the configuration error it is", async () => {
    const llm = new ClaudeCodeLLM({
      maxRetries: 0,
      bin: fakeCli({ is_error: false, stop_reason: "tool_use", result: "" }),
    });
    await expect(llm.complete({ system: "s", user: "u", tier: "small" }))
      .rejects.toThrow(/stopped to call a tool/);
  });
});

describe("effort", () => {
  it("asks for less thinking on rubric-bound work than on generative work", async () => {
    const { defaultEffort } = await import("../src/provider.js");
    expect(defaultEffort("small")).toBe("low");
    expect(defaultEffort("strong")).toBe("medium");
  });
});
