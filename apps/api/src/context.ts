import { db } from "@kg/db";
import { DeterministicEmbedding, LLMAdjudicator, embeddingFromEnv } from "@kg/graph";
import { AnthropicLLM, ClaudeCodeLLM, OpenAICompatibleLLM, llmFromEnv, type LLMProvider } from "@kg/llm";

import { isProduction } from "./admin.js";

export const prisma = db();
export const embedding = embeddingFromEnv();

let llm: LLMProvider | null | undefined;

export interface ModelSettings {
  provider: "claude-code" | "anthropic" | "openai" | "none";
  small: string;
  strong: string;
}

const SETTING_KEY = "model";

export async function loadModelSettings(): Promise<ModelSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
  if (row) return row.value as unknown as ModelSettings;
  const fromEnv = llmFromEnv();
  if (!fromEnv) return { provider: "none", small: "", strong: "" };
  // OpenRouter model ids contain "/", so prefer the env over parsing the name
  const [, models] = fromEnv.name.split(":");
  const [parsedSmall = "", parsedStrong = ""] = (models ?? "").split("/");
  const small = process.env.LLM_MODEL_SMALL ?? parsedSmall;
  const strong = process.env.LLM_MODEL_STRONG ?? parsedStrong;
  const provider = fromEnv.name.startsWith("claude-code")
    ? "claude-code"
    : fromEnv.name.startsWith("anthropic")
      ? "anthropic"
      : "openai";
  return { provider, small, strong };
}

export async function saveModelSettings(next: ModelSettings): Promise<ModelSettings> {
  await prisma.appSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: next as never },
    update: { value: next as never },
  });
  llm = undefined;
  return next;
}

let settingsCache: ModelSettings | null = null;
export async function refreshLlm(): Promise<void> {
  settingsCache = await loadModelSettings();
  llm = undefined;
}

function buildFromSettings(s: ModelSettings): LLMProvider | null {
  const models = { small: s.small, strong: s.strong };
  const baseUrl = process.env.LLM_BASE_URL ? { baseUrl: process.env.LLM_BASE_URL } : {};
  switch (s.provider) {
    case "claude-code":
      return isProduction() ? null : new ClaudeCodeLLM({ models });
    case "anthropic": {
      const key = process.env.ANTHROPIC_API_KEY;
      return key ? new AnthropicLLM({ apiKey: key, models, ...baseUrl }) : null;
    }
    case "openai": {
      const key = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
      return key ? new OpenAICompatibleLLM({ apiKey: key, models, ...baseUrl }) : null;
    }
    default:
      return null;
  }
}

/** Null when no provider is configured; routes that need a model return 503, not a mock */
export function getLlm(): LLMProvider | null {
  if (llm === undefined) {
    llm = settingsCache ? buildFromSettings(settingsCache) : llmFromEnv();
    if (llm) {
      // Fire-and-forget: a metrics failure must not fail a lesson
      llm.onUsage = (usage, req) => {
        void prisma.usageRecord
          .create({
            data: {
              purpose: purposeOf(req.system),
              tier: usage.tier,
              model: usage.model,
              promptTokens: usage.promptTokens,
              outputTokens: usage.outputTokens,
              costUsd: usage.costUsd,
            },
          })
          .catch(() => undefined);
      };
    }
  }
  return llm;
}

function purposeOf(system: string): string {
  if (system.includes("decide whether a proposed learning concept")) return "adjudicate";
  if (system.includes("break a learning topic")) return "expand_topic";
  if (system.includes("immediate prerequisites")) return "expand_prerequisites";
  if (system.includes("grade a learner")) return "grade";
  if (system.includes("classify a learner")) return "route_chat";
  if (system.includes("write assessment items")) return "generate_items";
  if (system.includes("excellent tutor")) return "baseline_turn";
  // An unmatched prompt is filed as "other", so keep this list in step with the prompts
  if (system.includes("You explain one concept")) return "explain";
  if (system.includes("Answer the learner's question")) return "answer_chat";
  if (system.includes("capabilities a learner gains")) return "milestones";
  if (system.includes("turn a learner's stated goal")) return "resolve_goal";
  if (system.includes("interactive teaching widget") || system.includes("catalog")) return "widget";
  if (system.includes("denotes more than one concept")) return "split_names";
  return "other";
}

export function resolverDeps() {
  const provider = getLlm();
  if (!provider) return null;
  return { prisma, embedding, adjudicator: new LLMAdjudicator(provider) };
}

export function providerStatus() {
  const provider = getLlm();
  const stubEmbedding = embedding instanceof DeterministicEmbedding;
  return {
    llm: provider ? provider.name : null,
    embedding: embedding.name,
    stubEmbedding,
    degraded: !provider || stubEmbedding,
    caveats: [
      ...(provider ? [] : ["no model configured — expansion, grading and chat return 503"]),
      ...(stubEmbedding
        ? [
            "embeddings are a lexical hash stub, so the resolver's semantic arm cannot " +
              "surface a synonym that shares no wording; dedup leans on the lexical and " +
              "graph-local arms only",
          ]
        : []),
      ...(provider?.name.startsWith("claude-code")
        ? [
            "backed by the local Claude Code CLI: several seconds per call, and each " +
              "call pays for the CLI's own system prompt, so cost figures are inflated " +
              "and not comparable to an API-backed run",
          ]
        : []),
    ],
  };
}
