import { spawn } from "node:child_process";
import { LLMError, type CompletionRequest, type LLMProvider, type ModelTier, type UsageSink } from "./provider.js";

export interface ClaudeCodeOptions {
  /** Path to the CLI. Defaults to whatever `claude` resolves to on PATH. */
  bin?: string;
  models?: Record<ModelTier, string>;
  timeoutMs?: number;
  /** Concurrent subprocesses. Each is a full CLI boot, so this is not free. */
  maxConcurrent?: number;
  /** Retries per call. Transient CLI failures are common over a long fan-out. */
  maxRetries?: number;
}

interface CliResult {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

/**
 * Uses the local `claude` CLI in print mode as the model backend.
 *
 * This exists so the system can run with no API key on a machine where Claude Code is
 * already installed and authenticated. It is a **development** path, and the trade-offs
 * are real rather than theoretical:
 *
 *   - **Latency.** Every call boots a CLI process: roughly 3–6 seconds even for a
 *     one-line answer, against a few hundred milliseconds for a direct API call.
 *     Expansion, which fans out to dozens of calls, goes from seconds to minutes.
 *   - **Cost is inflated and the inflation is invisible.** Each invocation pays to
 *     establish Claude Code's own system prompt — several thousand cache-creation
 *     tokens before your prompt is even considered. A trivial adjudication that would
 *     cost a fraction of a cent through the API reports around a cent here. Cost per
 *     verified outcome measured this way is real spend, but it is *not* the number the
 *     architecture's economics argument is about, and it should not be compared against
 *     an API-backed run.
 *   - **Not a serving path.** It is an interactive developer tool driven by a
 *     subprocess, with no connection pooling, no streaming into our pipeline, and
 *     no useful behaviour under concurrency beyond what the semaphore below imposes.
 *
 * Use it to exercise the system end to end. Switch to `AnthropicLLM` before drawing any
 * conclusion about cost, latency, or throughput.
 */
export class ClaudeCodeLLM implements LLMProvider {
  readonly name: string;
  onUsage?: UsageSink | undefined;

  private readonly bin: string;
  private readonly models: Record<ModelTier, string>;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly maxRetries: number;
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(opts: ClaudeCodeOptions = {}) {
    this.bin = opts.bin ?? "claude";
    this.models = opts.models ?? { small: "haiku", strong: "sonnet" };
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.maxRetries = opts.maxRetries ?? 2;
    this.name = `claude-code:${this.models.small}/${this.models.strong}`;
  }

  async complete(req: CompletionRequest): Promise<string> {
    // A long fan-out makes dozens of sequential CLI invocations and some of them fail
    // transiently. Without a retry, one bad call in fifty destroys an expansion that
    // has already run for minutes — so retry before giving up.
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.acquire();
      try {
        return await this.run(req);
      } catch (err) {
        lastError = err;
        // A missing binary will not fix itself; retrying just wastes time.
        if (err instanceof LLMError && err.message.includes("could not run")) throw err;
      } finally {
        this.release();
      }
      if (attempt < this.maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }

  private run(req: CompletionRequest): Promise<string> {
    const started = Date.now();
    const model = this.models[req.tier];

    return new Promise<string>((resolve, reject) => {
      const args = [
        "-p",
        req.user,
        // Replaces Claude Code's prompt rather than appending to it, so the model is
        // not simultaneously told it is a coding agent.
        "--system-prompt",
        req.system,
        "--model",
        model,
        "--output-format",
        "json",
        // One response. No tool loop, no follow-up turns.
        "--max-turns",
        "1",
      ];

      const child = spawn(this.bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          new LLMError(
            `could not run "${this.bin}": ${err.message}. Is Claude Code installed and on PATH?`,
            err,
          ),
        );
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new LLMError(`claude CLI timed out after ${this.timeoutMs}ms`));
          return;
        }
        if (code !== 0) {
          // stderr is often empty on CLI failures, so stdout has to be reported too or
          // the error says nothing at all.
          const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(" | ");
          reject(new LLMError(`claude CLI exited ${code}: ${detail.slice(0, 600) || "(no output)"}`));
          return;
        }

        let parsed: CliResult;
        try {
          parsed = JSON.parse(stdout) as CliResult;
        } catch {
          reject(new LLMError(`claude CLI returned unparseable output: ${stdout.slice(0, 300)}`));
          return;
        }
        if (parsed.is_error || typeof parsed.result !== "string") {
          reject(new LLMError(`claude CLI reported an error: ${JSON.stringify(parsed).slice(0, 400)}`));
          return;
        }

        const usage = parsed.usage ?? {};
        this.onUsage?.(
          {
            model,
            tier: req.tier,
            // Cache-creation tokens are most of the input here and they are Claude
            // Code's own prompt, not ours. Counted, because they are really paid for.
            promptTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
            outputTokens: usage.output_tokens ?? 0,
            costUsd: parsed.total_cost_usd ?? 0,
            durationMs: parsed.duration_ms ?? Date.now() - started,
          },
          req,
        );

        resolve(parsed.result);
      });
    });
  }
}
