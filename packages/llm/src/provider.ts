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

export interface CompletionRequest {
  system: string;
  user: string;
  tier: ModelTier;
  /** Sampling temperature. Self-consistency expansion needs this above zero. */
  temperature?: number;
  maxTokens?: number;
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
  /** Set by the host so cost-per-outcome is measured rather than assumed. */
  onUsage?: UsageSink | undefined;
}

export class LLMError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LLMError";
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
