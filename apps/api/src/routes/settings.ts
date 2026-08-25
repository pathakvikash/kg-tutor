import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadModelSettings, saveModelSettings, refreshLlm, providerStatus } from "../context.js";

/** Model options that actually exist, so the UI is not a free-text guess. */
const CATALOG = {
  "claude-code": {
    label: "Claude Code CLI (no API key)",
    models: ["haiku", "sonnet", "opus"],
    note: "Uses the local CLI. A few seconds per call, and each call pays for the CLI's own system prompt, so cost figures run high and are not comparable to the API.",
  },
  anthropic: {
    label: "Anthropic API",
    models: ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"],
    note: "Needs ANTHROPIC_API_KEY in the environment.",
  },
  openai: {
    label: "OpenAI-compatible",
    models: ["gpt-4o-mini", "gpt-4o"],
    note: "Needs OPENAI_API_KEY or LLM_API_KEY.",
  },
} as const;

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings/model", async () => ({
    current: await loadModelSettings(),
    catalog: CATALOG,
    status: providerStatus(),
  }));

  app.put("/api/settings/model", async (req, reply) => {
    const body = z
      .object({
        provider: z.enum(["claude-code", "anthropic", "openai", "none"]),
        small: z.string(),
        strong: z.string(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    await saveModelSettings(body.data);
    await refreshLlm();
    const status = providerStatus();
    if (body.data.provider !== "none" && !status.llm) {
      // Saved, but the key is missing — say so instead of silently doing nothing.
      return reply.code(422).send({
        error: `${body.data.provider} selected but no API key is set in the environment`,
        current: body.data,
        status,
      });
    }
    return { current: body.data, status };
  });
}
