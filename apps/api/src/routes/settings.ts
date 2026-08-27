import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadModelSettings, saveModelSettings, refreshLlm, providerStatus } from "../context.js";

/** Model options that actually exist, so the UI is not a free-text guess. */
const CATALOG = {
  "claude-code": {
    label: "Claude Code CLI (no API key)",
    models: ["haiku", "sonnet", "opus"],
    // Tier defaults used when switching provider, so the UI never has to guess.
    defaultSmall: "haiku",
    defaultStrong: "sonnet",
    note: "Uses the local CLI. A few seconds per call, and each call pays for the CLI's own system prompt, so cost figures run high and are not comparable to the API.",
    /** Named so a missing key can be reported as a next step rather than a fault. */
    keyEnv: null,
  },
  anthropic: {
    label: "Anthropic API",
    models: ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"],
    defaultSmall: "claude-haiku-4-5-20251001",
    defaultStrong: "claude-sonnet-5",
    note: "Needs ANTHROPIC_API_KEY in the environment.",
    keyEnv: "ANTHROPIC_API_KEY",
  },
  openai: {
    label: "OpenAI-compatible",
    models: ["gpt-4o-mini", "gpt-4o"],
    defaultSmall: "gpt-4o-mini",
    defaultStrong: "gpt-4o",
    note: "Needs OPENAI_API_KEY or LLM_API_KEY.",
    keyEnv: "OPENAI_API_KEY",
  },
} as const;

const PROVIDERS = ["claude-code", "anthropic", "openai", "none"] as const;

/** Adding a provider to CATALOG without listing it in PROVIDERS is a compile error. */
type CatalogIsCovered =
  keyof typeof CATALOG extends (typeof PROVIDERS)[number] ? true : "CATALOG has a provider PROVIDERS does not list";
const _providersCoverCatalog: CatalogIsCovered = true;
void _providersCoverCatalog;

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings/model", async () => ({
    current: await loadModelSettings(),
    catalog: CATALOG,
    status: providerStatus(),
  }));

  app.put("/api/settings/model", async (req, reply) => {
    const body = z
      .object({
        provider: z.enum(PROVIDERS),
        small: z.string(),
        strong: z.string(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    await saveModelSettings(body.data);
    await refreshLlm();
    const status = providerStatus();
    if (body.data.provider !== "none" && !status.llm) {
      // Saved, but the key is missing, so the response carries a remedy the client renders.
      const entry = CATALOG[body.data.provider as keyof typeof CATALOG];
      const keyEnv = entry?.keyEnv ?? null;
      return reply.code(422).send({
        error: `${entry?.label ?? body.data.provider} was saved, but no usable credential was found, so model calls will fail.`,
        remedy: keyEnv
          ? `Set ${keyEnv} in the environment and restart the API. The choice above is already saved — you do not need to set it again.`
          : "Run `claude` once in a terminal to sign in, then restart the API.",
        current: body.data,
        status,
      });
    }
    return { current: body.data, status };
  });
}
