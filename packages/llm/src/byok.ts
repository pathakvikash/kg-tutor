import dns from "node:dns";
import net from "node:net";
import { z } from "zod";
import { AnthropicLLM, OpenAICompatibleLLM } from "./providers.js";
import {
  LLMError,
  providerError,
  providerFetch,
  readCapped,
  type LLMProvider,
} from "./provider.js";

/** Message is safe to show the visitor: fixed text, never zod detail or the key */
export class ByokConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ByokConfigError";
  }
}

const MAX_HEADER_BYTES = 4096;
const token = (min: number, max: number) => new RegExp(`^[\\x21-\\x7e]{${min},${max}}$`);

const base = z.object({
  provider: z.enum(["openrouter", "anthropic", "openai", "custom"]),
  baseUrl: z.string().max(300).optional(),
  apiKey: z.string().regex(token(8, 512)),
});
const customNeedsUrl = (cfg: { provider: string; baseUrl?: string | undefined }, ctx: z.RefinementCtx) => {
  if (cfg.provider === "custom" && !cfg.baseUrl) ctx.addIssue({ code: "custom", path: ["baseUrl"] });
};

const configSchema = base
  .extend({ small: z.string().regex(token(1, 200)), strong: z.string().regex(token(1, 200)) })
  .superRefine(customNeedsUrl);
const listSchema = base.superRefine(customNeedsUrl);

export type LlmConfig = z.infer<typeof configSchema>;
export type ModelListConfig = z.infer<typeof listSchema>;

function validate<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "body")))];
  throw new ByokConfigError(`${label} is not valid: ${fields.join(", ")}`);
}

export const validateModelListConfig = (body: unknown): ModelListConfig =>
  validate(listSchema, body, "The request");
export const validateLlmConfig = (body: unknown): LlmConfig => validate(configSchema, body, "The request");

export function parseLlmConfig(header: string): LlmConfig {
  if (header.length > MAX_HEADER_BYTES) throw new ByokConfigError("x-llm-config is too large");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new ByokConfigError("x-llm-config is not valid: encoding");
  }
  return validate(configSchema, value, "x-llm-config");
}

// IPv4-mapped IPv6 is checked against the IPv4 rules by BlockList itself
const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["64:ff9b::", 96],
] as const) BLOCKED.addSubnet(addr, prefix, "ipv6");

export type Lookup = (host: string, opts: { all: true }) => Promise<{ address: string; family: number }[]>;

/**
 * Returns the base URL without a trailing slash, or throws ByokConfigError.
 * ponytail: DNS is checked at request time, so rebinding can slip past; https and cert checks
 * contain it. Upgrade: an undici Agent with connect.lookup that checks the address it dials.
 */
export async function assertPublicHttpsUrl(
  raw: string,
  lookup: Lookup = dns.promises.lookup,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ByokConfigError("The base URL is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new ByokConfigError("The base URL must start with https://.");
  if (url.username || url.password || url.search || url.hash) {
    throw new ByokConfigError("The base URL must not contain credentials, a query or a fragment.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) !== 0) throw new ByokConfigError("Use a host name in the base URL, not an IP address.");
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new ByokConfigError("The base URL host name did not resolve.");
  }
  if (addrs.length === 0 || addrs.some((a) => BLOCKED.check(a.address, a.family === 6 ? "ipv6" : "ipv4"))) {
    throw new ByokConfigError("The base URL points to a private or reserved address.");
  }
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

const FIXED_BASE = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
} as const;

async function baseUrlFor(
  cfg: ModelListConfig,
  lookup: Lookup,
): Promise<string> {
  return cfg.provider === "custom" ? assertPublicHttpsUrl(cfg.baseUrl ?? "", lookup) : FIXED_BASE[cfg.provider];
}

/** Reads no process.env and attaches no onUsage, so a visitor's calls never touch server config or metrics */
export async function providerFromConfig(cfg: LlmConfig, lookup: Lookup = dns.promises.lookup): Promise<LLMProvider> {
  const opts = { apiKey: cfg.apiKey, models: { small: cfg.small, strong: cfg.strong }, baseUrl: await baseUrlFor(cfg, lookup) };
  return cfg.provider === "anthropic" ? new AnthropicLLM(opts) : new OpenAICompatibleLLM(opts);
}

/** A present header never falls back: a bad key must not silently spend the owner's */
export async function resolveLlm(
  header: string | undefined,
  fallback: () => LLMProvider | null,
): Promise<LLMProvider | null> {
  if (header === undefined) return fallback();
  return providerFromConfig(parseLlmConfig(header));
}

/** Model ids the visitor's key can see, deduped and sorted */
export async function listModels(cfg: ModelListConfig, lookup: Lookup = dns.promises.lookup): Promise<string[]> {
  const root = await baseUrlFor(cfg, lookup);
  const url = cfg.provider === "anthropic" ? `${root}/models?limit=1000` : `${root}/models`;
  const headers: Record<string, string> =
    cfg.provider === "anthropic"
      ? { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${cfg.apiKey}` };
  const res = await providerFetch(url, { headers }, 10_000);
  if (res.status === 404) throw new LLMError("No model list at that URL. The base URL should be the /v1 root.");
  if (!res.ok) throw await providerError(res, cfg.apiKey, "model list");
  let body: { data?: { id?: unknown }[] };
  try {
    body = JSON.parse(await readCapped(res, 10_000_000));
  } catch (err) {
    if (err instanceof LLMError) throw err;
    throw new LLMError("The model list was not valid JSON.");
  }
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  return [...new Set(ids)].sort();
}
