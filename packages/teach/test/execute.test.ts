import { describe, it, expect } from "vitest";
import { executeJs } from "../src/execute.js";

describe("executeJs", () => {
  it("runs correct learner code against a harness", async () => {
    const r = await executeJs({
      code: `export const double = (n) => n * 2;\nglobalThis.double = double;`,
      harness: `if (globalThis.double(21) !== 42) { throw new Error("wrong"); } console.log("ok");`,
    });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("ok");
  });

  it("reports a failing assertion rather than passing it", async () => {
    const r = await executeJs({
      code: `globalThis.double = (n) => n + 2;`,
      harness: `if (globalThis.double(21) !== 42) { throw new Error("expected 42"); }`,
    });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("expected 42");
  });

  it("kills an infinite loop instead of hanging the session", async () => {
    const r = await executeJs({ code: `while (true) {}`, timeoutMs: 1200 });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("timed out");
    expect(r.durationMs).toBeLessThan(6000);
  });

  it("does not leak the host environment into learner code", async () => {
    process.env.KG_SECRET_CANARY = "should-not-be-visible";
    const r = await executeJs({
      code: `console.log(JSON.stringify({
        canary: process.env.KG_SECRET_CANARY ?? null,
        db: process.env.DATABASE_URL ?? null,
      }));`,
    });
    delete process.env.KG_SECRET_CANARY;
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.stdout.trim())).toEqual({ canary: null, db: null });
  });

  it("truncates runaway output instead of buffering without limit", async () => {
    const r = await executeJs({
      code: `for (let i = 0; i < 200000; i++) console.log("x".repeat(50));`,
      timeoutMs: 8000,
    });
    expect(r.stdout.length).toBeLessThan(20_000);
  });

  it("reports a syntax error as a failure, not a crash", async () => {
    const r = await executeJs({ code: `const = ;` });
    expect(r.ok).toBe(false);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});
