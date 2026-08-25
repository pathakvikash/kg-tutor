import type { PrismaClient } from "@kg/db";
import type { LLMProvider } from "@kg/llm";

/**
 * The control arm of the product experiment: a good tutor prompt on a strong model,
 * with no graph, no learner model and no plan. (14)
 *
 * It is deliberately a *fair* baseline, not a strawman — a strong system prompt on the
 * strong tier, given the same conversation history. If the graph cannot beat this, the
 * graph is not earning its complexity, and that is a result worth having early.
 *
 * What it structurally cannot do is the point:
 *   - no cross-session memory of what the learner knows
 *   - no ordering derived from real dependencies
 *   - nothing accumulates, so quality and cost per outcome stay flat forever
 */
export const BASELINE_SYSTEM_PROMPT = `You are an excellent tutor. Teach the learner what they ask about.

Explain clearly, use concrete examples, check their understanding with questions, and
adapt to their answers. Be encouraging but honest — if an answer is wrong, say so and
explain why.`;

export interface BaselineTurnInput {
  prisma: PrismaClient;
  llm: LLMProvider;
  sessionId: string;
  history: { role: "learner" | "tutor"; text: string }[];
  message: string;
}

export async function baselineTurn(input: BaselineTurnInput): Promise<string> {
  const transcript = input.history
    .map((h) => `${h.role === "learner" ? "Learner" : "Tutor"}: ${h.text}`)
    .join("\n");

  const reply = await input.llm.complete({
    system: BASELINE_SYSTEM_PROMPT,
    user: `${transcript}\nLearner: ${input.message}`,
    tier: "strong",
    temperature: 0.7,
  });

  // The baseline records usage so the two arms are cost-comparable, and nothing else.
  // No evidence, no mastery, no plan — that asymmetry IS the experiment.
  await input.prisma.usageRecord.create({
    data: {
      sessionId: input.sessionId,
      purpose: "baseline_turn",
      tier: "strong",
      model: input.llm.name,
    },
  });

  return reply;
}

/** Assigns a learner to an arm, stably, so they stay in one for the whole study. (14) */
export function assignVariant(learnerId: string, split = 0.5): "graph" | "baseline" {
  let h = 2166136261;
  for (let i = 0; i < learnerId.length; i++) {
    h ^= learnerId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (Math.abs(h) % 1000) / 1000 < split ? "graph" : "baseline";
}
