import type { FastifyInstance } from "fastify";
import {
  listModels,
  providerFromConfig,
  validateLlmConfig,
  validateModelListConfig,
  type LLMProvider,
  type ModelTier,
} from "@kg/llm";

const TEST_TIMEOUT_MS = 30_000;

type TierResult = { ok: true; ms: number } | { ok: false; error: string };

async function pingTier(llm: LLMProvider, tier: ModelTier, apiKey: string): Promise<TierResult> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The model provider did not answer in time.")), TEST_TIMEOUT_MS);
  });
  try {
    // 256 tokens: reasoning models spend the limit on thinking before they answer
    await Promise.race([
      llm.complete({ system: "Reply with OK.", user: "ping", tier, maxTokens: 256 }),
      deadline,
    ]);
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : "The call failed.";
    return { ok: false, error: message.replaceAll(apiKey, "[redacted]").slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

export async function llmRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/llm/models", async (req) => ({
    models: await listModels(validateModelListConfig(req.body)),
  }));

  app.post("/api/llm/test", async (req) => {
    const cfg = validateLlmConfig(req.body);
    const llm = await providerFromConfig(cfg);
    const [small, strong] = await Promise.all([
      pingTier(llm, "small", cfg.apiKey),
      pingTier(llm, "strong", cfg.apiKey),
    ]);
    return { small, strong };
  });
}
