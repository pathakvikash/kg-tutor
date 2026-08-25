import { db } from "@kg/db";
import { DeterministicEmbedding, LLMAdjudicator, embeddingFromEnv } from "@kg/graph";
import { llmFromEnv, type LLMProvider } from "@kg/llm";

export const prisma = db();
export const embedding = embeddingFromEnv();

let llm: LLMProvider | null | undefined;

/** Null when no key is configured — routes that need a model return 503, not a mock. */
export function getLlm(): LLMProvider | null {
  if (llm === undefined) llm = llmFromEnv();
  return llm;
}

export function resolverDeps() {
  const provider = getLlm();
  if (!provider) return null;
  return { prisma, embedding, adjudicator: new LLMAdjudicator(provider) };
}

export function providerStatus() {
  const provider = getLlm();
  return {
    llm: provider ? provider.name : null,
    embedding: embedding.name,
    /** True when both are stubs — the UI says so rather than implying live behaviour. */
    degraded: !provider || embedding instanceof DeterministicEmbedding,
  };
}
