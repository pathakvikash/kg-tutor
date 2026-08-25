import { db } from "@kg/db";
import { DeterministicEmbedding, LLMAdjudicator, embeddingFromEnv } from "@kg/graph";
import { llmFromEnv, type LLMProvider } from "@kg/llm";

export const prisma = db();
export const embedding = embeddingFromEnv();

let llm: LLMProvider | null | undefined;

/** Null when no provider is configured — routes that need a model return 503, not a mock. */
export function getLlm(): LLMProvider | null {
  if (llm === undefined) {
    llm = llmFromEnv();
    if (llm) {
      // Every call is costed, so `cost per verified outcome` is measured rather than
      // assumed. Writes are fire-and-forget: a metrics failure must not fail a lesson.
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

/** Derived from the system prompt, so callers cannot forget to label their spend. */
function purposeOf(system: string): string {
  if (system.includes("decide whether a proposed learning concept")) return "adjudicate";
  if (system.includes("break a learning topic")) return "expand_topic";
  if (system.includes("immediate prerequisites")) return "expand_prerequisites";
  if (system.includes("grade a learner")) return "grade";
  if (system.includes("classify a learner")) return "route_chat";
  if (system.includes("write assessment items")) return "generate_items";
  if (system.includes("excellent tutor")) return "baseline_turn";
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
    /** Named so the UI can say what is actually weakened, not just "degraded". */
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
