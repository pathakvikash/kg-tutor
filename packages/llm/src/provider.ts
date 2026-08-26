import { z } from "zod";

/**
 * Two tiers, per decision 17.
 *
 * `small` is for narrow, rubric-bound, verifiable work: grading against stored failure
 * modes, classifying a failure, routing a chat question, adjudicating a resolver
 * verdict. A small model is arguably *better* at grading than a large one, which is
 * more likely to charitably reinterpret a bad answer into a good one.
 *
 * `strong` is for graph expansion, explanation adaptation and novel diagnosis.
 */
export type ModelTier = "small" | "strong";

/**
 * How long the model should reason before answering.
 *
 * Worth separating from `tier` because they answer different questions: tier is how
 * capable the model needs to be, effort is how long it should think. Grading against a
 * stored rubric wants a capable-enough model that answers immediately; expanding a graph
 * wants room to reason.
 *
 * Left unset it defaults by tier. Measured on the calls this system actually makes,
 * "high" bought nothing: a grading call ran 15.0s with 1,085 thinking tokens against 126
 * tokens of answer, and reached the same verdict as "low" at 8.7s. Item generation was
 * worse — 41.5s and $0.0435 at high against 13.2s and $0.0145 at low, for four items of
 * indistinguishable quality either way.
 */
export type Effort = "low" | "medium" | "high";

/** Thinking helps novel reasoning, not rubric-bound checking. (17) */
export function defaultEffort(tier: ModelTier): Effort {
  return tier === "small" ? "low" : "medium";
}

export interface CompletionRequest {
  system: string;
  user: string;
  tier: ModelTier;
  /** Sampling temperature. Self-consistency expansion needs this above zero. */
  temperature?: number;
  maxTokens?: number;
  /** Overrides {@link defaultEffort} for a call that genuinely needs to reason. */
  effort?: Effort;
}

/** What a call actually cost, when the provider can tell us. (17) */
export interface UsageReport {
  model: string;
  tier: ModelTier;
  promptTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export type UsageSink = (usage: UsageReport, req: CompletionRequest) => void;

export interface LLMProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<string>;
  /**
   * Incremental text, where the provider supports it.
   *
   * Optional on purpose: a provider without it still works, callers just wait. Anything
   * that must be schema-validated has to wait anyway — you cannot check a shape against
   * half a document — so this is for prose, where the wait is the whole problem.
   */
  stream?(req: CompletionRequest): AsyncIterable<string>;
  /** Set by the host so cost-per-outcome is measured rather than assumed. */
  onUsage?: UsageSink | undefined;
}

/** Streams when the provider can, falls back to one chunk when it cannot. */
export async function* streamOrComplete(
  provider: LLMProvider,
  req: CompletionRequest,
): AsyncIterable<string> {
  if (provider.stream) {
    yield* provider.stream(req);
    return;
  }
  yield await provider.complete(req);
}

/**
 * Starts a stream NOW and buffers what arrives until someone reads it.
 *
 * Async generators are lazy: building the iterator does nothing, and the underlying
 * call does not begin until the first `next()`. So kicking off a stream "in parallel"
 * with another await does not overlap them at all — the stream simply starts late,
 * which is exactly the bug this exists to prevent. Wrapping it in an eager pump makes
 * the concurrency real.
 */
export function startStream(
  provider: LLMProvider,
  req: CompletionRequest,
): { chunks: AsyncIterable<string>; cancel: () => void } {
  const buffered: string[] = [];
  let waiting: (() => void) | null = null;
  let finished = false;
  let failure: unknown = null;
  let cancelled = false;

  const wake = () => {
    const w = waiting;
    waiting = null;
    w?.();
  };

  void (async () => {
    try {
      for await (const chunk of streamOrComplete(provider, req)) {
        if (cancelled) break;
        buffered.push(chunk);
        wake();
      }
    } catch (err) {
      failure = err;
    } finally {
      finished = true;
      wake();
    }
  })();

  async function* drain(): AsyncIterable<string> {
    for (;;) {
      while (buffered.length > 0) yield buffered.shift()!;
      if (failure) throw failure;
      if (finished) return;
      await new Promise<void>((resolve) => { waiting = resolve; });
    }
  }

  return {
    chunks: drain(),
    // Lets an abandoned speculative answer stop consuming rather than run to completion.
    cancel: () => { cancelled = true; wake(); },
  };
}

export class LLMError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LLMError";
  }
}

/**
 * The provider is reachable but will not serve us — an expired login, a revoked key, a
 * hit quota. Distinct from LLMError because the response is different in every way:
 * retrying is pointless, and the fix is a specific action by a human, so it needs to be
 * said plainly rather than buried in a stack trace.
 */
export class LLMAuthError extends LLMError {
  constructor(
    message: string,
    /** What the person running this should actually do about it. */
    readonly remedy: string,
  ) {
    super(message);
    this.name = "LLMAuthError";
  }
}

/**
 * Models wrap JSON in prose and fences no matter how firmly asked not to. Pull the
 * first balanced object or array out rather than failing the whole call.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(body);
  } catch {
    // fall through to balance scanning
  }

  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = body.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < body.length; i++) {
      const ch = body[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(body.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new LLMError(`no parseable JSON in response: ${text.slice(0, 300)}`);
}

/**
 * Accepts either `{key: [...]}` or a bare `[...]`.
 *
 * Models drop the wrapper object routinely, especially on the small tier, and a strict
 * schema turns that into a hard failure of the whole call. The wrapper carries no
 * information, so insisting on it buys nothing and costs a retry — or, worse, a 500
 * halfway through a multi-step flow.
 */
export function arrayOrWrapped<T>(key: string, item: z.ZodType<T>) {
  return z.preprocess(
    (raw) => (Array.isArray(raw) ? { [key]: raw } : raw),
    z.object({ [key]: z.array(item) } as Record<string, z.ZodType<T[]>>),
  ) as unknown as z.ZodType<Record<string, T[]>>;
}

/**
 * One retry on a schema mismatch, with the validation error fed back. Beyond that the
 * caller decides — silently accepting malformed structure is how bad data gets in.
 */
export async function completeJson<T>(
  provider: LLMProvider,
  req: CompletionRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  const first = await provider.complete(req);
  try {
    return schema.parse(extractJson(first));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const retry = await provider.complete({
      ...req,
      user: `${req.user}\n\nYour previous response could not be used:\n${detail}\n\nReturn only valid JSON matching the required shape.`,
    });
    try {
      return schema.parse(extractJson(retry));
    } catch (err2) {
      throw new LLMError(
        `response failed schema validation twice: ${err2 instanceof Error ? err2.message : String(err2)}`,
        err2,
      );
    }
  }
}
