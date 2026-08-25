import { LLMError, type CompletionRequest, type LLMProvider, type ModelTier } from "./provider.js";

export interface TierModels {
  small: string;
  strong: string;
}

/** Any OpenAI-compatible `/chat/completions` endpoint. */
export class OpenAICompatibleLLM implements LLMProvider {
  readonly name: string;

  constructor(
    private readonly opts: {
      apiKey: string;
      models: TierModels;
      baseUrl?: string;
    },
  ) {
    this.name = `openai:${opts.models.small}/${opts.models.strong}`;
  }

  async complete(req: CompletionRequest): Promise<string> {
    const base = this.opts.baseUrl ?? "https://api.openai.com/v1";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.models[req.tier],
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? 2048,
      }),
    });
    if (!res.ok) throw new LLMError(`chat completion failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new LLMError("no content in completion response");
    return content;
  }
}

export class AnthropicLLM implements LLMProvider {
  readonly name: string;

  constructor(
    private readonly opts: {
      apiKey: string;
      models: TierModels;
      baseUrl?: string;
    },
  ) {
    this.name = `anthropic:${opts.models.small}/${opts.models.strong}`;
  }

  async complete(req: CompletionRequest): Promise<string> {
    const base = this.opts.baseUrl ?? "https://api.anthropic.com/v1";
    const res = await fetch(`${base}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.opts.models[req.tier],
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? 2048,
      }),
    });
    if (!res.ok) throw new LLMError(`messages call failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string") throw new LLMError("no text block in messages response");
    return text;
  }
}

/** Records calls and replays canned responses. Tests exercise our code, not a model. */
export class ScriptedLLM implements LLMProvider {
  readonly name = "scripted";
  public calls: CompletionRequest[] = [];

  constructor(private readonly respond: (req: CompletionRequest, callIndex: number) => string) {}

  async complete(req: CompletionRequest): Promise<string> {
    const index = this.calls.length;
    this.calls.push(req);
    return this.respond(req, index);
  }

  callsForTier(tier: ModelTier): CompletionRequest[] {
    return this.calls.filter((c) => c.tier === tier);
  }
}

const ANTHROPIC_DEFAULTS: TierModels = {
  small: "claude-haiku-4-5-20251001",
  strong: "claude-opus-5",
};
const OPENAI_DEFAULTS: TierModels = { small: "gpt-4o-mini", strong: "gpt-4o" };

/**
 * Returns null when no key is configured, rather than a mock that silently produces
 * plausible-looking graph content. A fabricated concept is worse than a clear failure.
 */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LLMProvider | null {
  const models = (d: TierModels): TierModels => ({
    small: env.LLM_MODEL_SMALL ?? d.small,
    strong: env.LLM_MODEL_STRONG ?? d.strong,
  });

  if (env.ANTHROPIC_API_KEY) {
    return new AnthropicLLM({
      apiKey: env.ANTHROPIC_API_KEY,
      models: models(ANTHROPIC_DEFAULTS),
      ...(env.LLM_BASE_URL ? { baseUrl: env.LLM_BASE_URL } : {}),
    });
  }
  const key = env.LLM_API_KEY ?? env.OPENAI_API_KEY;
  if (key) {
    return new OpenAICompatibleLLM({
      apiKey: key,
      models: models(OPENAI_DEFAULTS),
      ...(env.LLM_BASE_URL ? { baseUrl: env.LLM_BASE_URL } : {}),
    });
  }
  return null;
}
