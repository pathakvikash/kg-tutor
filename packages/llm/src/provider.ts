import { z } from "zod";

/** `small` for rubric-bound verifiable work, `strong` for expansion and novel diagnosis. (17) */
export type ModelTier = "small" | "strong";

/** Thinking time, separate from `tier`, which is capability; defaults by tier when unset. */
export type Effort = "none" | "low" | "medium" | "high";

/** `none` is only for fixed-bucket classification, so `small` keeps a real budget. */
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
  /** Optional, and only useful for prose: a schema-validated call has to wait anyway. */
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

/** Eager pump: async generators are lazy, so a stream started in parallel would not overlap. */
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

/** Provider is reachable but refusing: retrying is pointless and a human has to act. */
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

/** A raw control char inside a JSON string is never valid, so repairing cannot corrupt one. */
function escapeControlCharsInStrings(body: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of body) {
    if (inString) {
      if (escaped) { escaped = false; out.push(ch); continue; }
      if (ch === "\\") { escaped = true; out.push(ch); continue; }
      if (ch === '"') { inString = false; out.push(ch); continue; }
      if (ch === "\n") { out.push("\\n"); continue; }
      if (ch === "\r") { out.push("\\r"); continue; }
      if (ch === "\t") { out.push("\\t"); continue; }
      if (ch < " ") { out.push(`\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`); continue; }
      out.push(ch);
      continue;
    }
    if (ch === '"') inString = true;
    out.push(ch);
  }
  return out.join("");
}

/** The first balanced {...} or [...] in the text, or null. */
function balancedSpan(body: string): string | null {
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
        if (depth === 0) return body.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** The parse error plus the ~120 characters surrounding the offending position. */
function describeJsonFailure(candidate: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const at = /at position (\d+)/.exec(message)?.[1];
  if (at === undefined) return `${message} — starts: ${candidate.slice(0, 200)}`;
  const pos = Number(at);
  const from = Math.max(0, pos - 60);
  return (
    `${message}\n` +
    `…${candidate.slice(from, pos)}` +
    `⟪HERE⟫${candidate.slice(pos, pos + 60)}…`
  );
}

/** Models wrap JSON in prose and fences, so pull the first balanced object or array out. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Ordered most likely first; a non-JSON fence must not be taken as the whole document.
  const candidates: string[] = [];
  const push = (v: string | null | undefined) => {
    const t = v?.trim();
    if (t && !candidates.includes(t)) candidates.push(t);
  };

  // A fence that says json is the strongest signal there is.
  push(/```json\s*([\s\S]*?)```/.exec(trimmed)?.[1]);
  // Then the response as it stands, and the first balanced object or array in it.
  push(trimmed);
  push(balancedSpan(trimmed));
  // Only then other fenced blocks, in case the model mistagged the JSON or left the tag off.
  for (const m of trimmed.matchAll(/```(?:[a-zA-Z0-9_-]*)\s*([\s\S]*?)```/g)) {
    push(m[1]);
    push(balancedSpan(m[1] ?? ""));
  }

  let lastError: unknown;
  let lastTried = trimmed;
  for (const candidate of candidates) {
    // Strict first; the repair only ever alters text that could not have been valid.
    for (const attempt of [candidate, escapeControlCharsInStrings(candidate)]) {
      try {
        return JSON.parse(attempt);
      } catch (err) {
        lastError = err;
        lastTried = attempt;
      }
    }
  }

  throw new LLMError(
    `no parseable JSON in a ${text.length}-char response: ${describeJsonFailure(lastTried, lastError)}`,
  );
}



/** Accepts `{key: [...]}` or a bare `[...]`, since models drop the wrapper routinely. */
export function arrayOrWrapped<T>(key: string, item: z.ZodType<T>) {
  return z.preprocess(
    (raw) => (Array.isArray(raw) ? { [key]: raw } : raw),
    z.object({ [key]: z.array(item) } as Record<string, z.ZodType<T[]>>),
  ) as unknown as z.ZodType<Record<string, T[]>>;
}

/** One retry on a schema mismatch with the error fed back; beyond that the caller decides. */
/** Local repairs tried before another model call; each is a mis-shaping seen in practice. */
function repairs(value: unknown): unknown[] {
  const out = [value];
  // `[{...}]` where an object was asked for. Unwrapped only when it is unambiguous.
  if (Array.isArray(value) && value.length === 1) out.push(value[0]);
  return out;
}

export async function completeJson<T>(
  provider: LLMProvider,
  req: CompletionRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  const first = await provider.complete(req);
  try {
    const extracted = extractJson(first);
    let lastErr: unknown;
    for (const candidate of repairs(extracted)) {
      try {
        return schema.parse(candidate);
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const retry = await provider.complete({
      ...req,
      user: `${req.user}\n\nYour previous response could not be used:\n${detail}\n\nReturn only valid JSON matching the required shape.`,
    });
    try {
      const extracted = extractJson(retry);
      let lastErr: unknown;
      for (const candidate of repairs(extracted)) {
        try {
          return schema.parse(candidate);
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    } catch (err2) {
      throw new LLMError(
        `response failed schema validation twice: ${err2 instanceof Error ? err2.message : String(err2)}`,
        err2,
      );
    }
  }
}
