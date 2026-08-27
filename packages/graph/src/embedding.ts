/** Identity vectors come from name plus sense, and sense is immutable, so never recompute. (05) */

export const EMBEDDING_DIM = 1536;

export interface EmbeddingProvider {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** The exact text a concept's identity vector is derived from. Do not change casually. */
export function identityText(canonicalName: string, sense: string): string {
  return `${canonicalName.trim()}\n${sense.trim()}`;
}

/** pgvector's text input format. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum) || 1;
  return v.map((x) => x / n);
}

/** A hashed token bag for plumbing tests; it captures lexical overlap, not meaning. */
export class DeterministicEmbedding implements EmbeddingProvider {
  readonly name = "deterministic";

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const v = new Array<number>(EMBEDDING_DIM).fill(0);
    const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
    for (const tok of tokens) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % EMBEDDING_DIM;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    return normalize(v);
  }
}

export interface OpenAICompatibleOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/** Any OpenAI-compatible `/embeddings` endpoint. */
export class OpenAICompatibleEmbedding implements EmbeddingProvider {
  readonly name: string;
  private readonly opts: Required<OpenAICompatibleOptions>;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = {
      apiKey: opts.apiKey,
      model: opts.model ?? "text-embedding-3-small",
      baseUrl: opts.baseUrl ?? "https://api.openai.com/v1",
    };
    this.name = `openai:${this.opts.model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.opts.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({ model: this.opts.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`embedding request failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    const out = new Array<number[]>(texts.length);
    for (const d of body.data) out[d.index] = d.embedding;
    for (let i = 0; i < out.length; i++) {
      const e = out[i];
      if (!e) throw new Error(`embedding provider returned no vector for input ${i}`);
      if (e.length !== EMBEDDING_DIM) {
        throw new Error(
          `embedding dim ${e.length} != schema dim ${EMBEDDING_DIM}; change both the ` +
            `Prisma column and the HNSW index if switching models`,
        );
      }
    }
    return out as number[][];
  }
}

export function embeddingFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const apiKey = env.EMBEDDING_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey) return new DeterministicEmbedding();
  return new OpenAICompatibleEmbedding({
    apiKey,
    ...(env.EMBEDDING_MODEL ? { model: env.EMBEDDING_MODEL } : {}),
    ...(env.EMBEDDING_BASE_URL ? { baseUrl: env.EMBEDDING_BASE_URL } : {}),
  });
}
