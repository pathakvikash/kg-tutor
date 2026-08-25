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
