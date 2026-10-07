import { spawn } from "node:child_process";
import {
  LLMAuthError, LLMError, defaultEffort,
  type CompletionRequest, type Effort, type LLMProvider, type ModelTier, type UsageSink,
} from "./provider.js";

export interface ClaudeCodeOptions {
  bin?: string;
  models?: Record<ModelTier, string>;
  timeoutMs?: number;
  maxConcurrent?: number;
  maxRetries?: number;
}

interface CliResult {
  is_error?: boolean;
  stop_reason?: string;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

/** Always pass `--effort`, or the CLI inherits the machine's session default */
function effortFlags(req: CompletionRequest): string[] {
  return ["--effort", req.effort ?? defaultEffort(req.tier)];
}

/** Caps thinking below the floor `--effort low` gives; zero is only safe for classification */
const THINKING_BUDGET: Record<Effort, string | null> = {
  none: "0",
  low: "1024",
  medium: "4096",
  high: null,
};

function envFor(req: CompletionRequest): NodeJS.ProcessEnv {
  const budget = THINKING_BUDGET[req.effort ?? defaultEffort(req.tier)];
  return budget === null
    ? { ...process.env }
    : { ...process.env, MAX_THINKING_TOKENS: budget };
}

/** Allowlist nothing: a tool blocklist cannot cover MCP servers or future built-ins */
const TEXT_ONLY = [
  "--tools", "",
  "--strict-mcp-config",
  "--setting-sources", "",
  // Fallback in case a future CLI changes what `--tools ""` means
  "--disallowed-tools",
  "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit",
];

/** Dev-only backend for running without an API key; its cost and latency are not API-comparable */
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
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.acquire();
      try {
        return await this.run(req);
      } catch (err) {
        lastError = err;
        // A missing binary and an expired login never recover, so fail fast
        if (err instanceof LLMAuthError) throw err;
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

  async *stream(req: CompletionRequest): AsyncIterable<string> {
    await this.acquire();
    const started = Date.now();
    const model = this.models[req.tier];

    const child = spawn(
      this.bin,
      [
        "-p", req.user,
        "--system-prompt", req.system,
        "--model", model,
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--max-turns", "1",
        ...TEXT_ONLY,
        ...effortFlags(req),
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: envFor(req) },
    );

    const timer = setTimeout(() => child.kill("SIGKILL"), this.timeoutMs);
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    // NDJSON: hold back a partial trailing line until its newline arrives
    let buffer = "";
    let sawText = false;
    try {
      for await (const chunk of child.stdout) {
        buffer += (chunk as Buffer).toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: any;
          try { event = JSON.parse(trimmed); } catch { continue; }

          if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
            const delta = event.event.delta;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              sawText = true;
              yield delta.text as string;
            }
            continue;
          }

          if (event.type === "result") {
            const message = typeof event.result === "string" ? event.result : "";
            if (event.is_error) {
              if (/authenticat|oauth|session expired|log ?in/i.test(message)) {
                throw new LLMAuthError(
                  `Claude Code is not authenticated: ${message}`,
                  "Run `claude` once in a terminal to sign in again, then retry.",
                );
              }
              throw new LLMError(`claude CLI failed: ${message.slice(0, 300)}`);
            }
            const usage = event.usage ?? {};
            this.onUsage?.(
              {
                model,
                tier: req.tier,
                promptTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
                outputTokens: usage.output_tokens ?? 0,
                costUsd: event.total_cost_usd ?? 0,
                durationMs: event.duration_ms ?? Date.now() - started,
              },
              req,
            );
            if (!sawText) throw new LLMError(`claude CLI produced no text: ${stderr.slice(0, 200)}`);
          }
        }
      }
    } finally {
      clearTimeout(timer);
      child.kill();
      this.release();
    }
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
        "--system-prompt",
        req.system,
        "--model",
        model,
        "--output-format",
        "json",
        "--max-turns",
        "1",
        ...TEXT_ONLY,
        ...effortFlags(req),
      ];

      const child = spawn(this.bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: envFor(req),
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
        // A failing CLI still prints a JSON body with a usable message in `result`
        let parsed: CliResult | null = null;
        try {
          parsed = JSON.parse(stdout) as CliResult;
        } catch {
          /* not JSON; fall through to the raw-output path below */
        }

        const message = typeof parsed?.result === "string" ? parsed.result : "";
        const failed = code !== 0 || parsed?.is_error === true || typeof parsed?.result !== "string";

        if (parsed?.stop_reason === "tool_use") {
          reject(
            new LLMError(
              "claude CLI stopped to call a tool. Text generation should never do that — " +
                "check that the TEXT_ONLY flags are still reaching the subprocess.",
            ),
          );
          return;
        }

        // Only match on failure; a successful answer about OAuth is not an auth error
        if (failed) {
          if (/authenticat|oauth|session expired|log ?in/i.test(message)) {
            reject(
              new LLMAuthError(
                `Claude Code is not authenticated: ${message}`,
                "Run `claude` once in a terminal to sign in again, then retry. " +
                  "Alternatively set ANTHROPIC_API_KEY and switch the provider in Settings.",
              ),
            );
            return;
          }
          if (/rate.?limit|quota|usage limit/i.test(message)) {
            reject(
              new LLMAuthError(
                `Claude Code refused the request: ${message}`,
                "Wait for the limit to reset, or switch to an API key in Settings.",
              ),
            );
            return;
          }
          const detail = message || [stderr.trim(), stdout.trim()].filter(Boolean).join(" | ");
          reject(new LLMError(`claude CLI failed (exit ${code}): ${detail.slice(0, 400) || "(no output)"}`));
          return;
        }

        const usage = parsed!.usage ?? {};
        this.onUsage?.(
          {
            model,
            tier: req.tier,
            // Cache-creation tokens are Claude Code's own prompt, counted because they are paid
            promptTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
            outputTokens: usage.output_tokens ?? 0,
            costUsd: parsed!.total_cost_usd ?? 0,
            durationMs: parsed!.duration_ms ?? Date.now() - started,
          },
          req,
        );

        resolve(parsed!.result as string);
      });
    });
  }
}
