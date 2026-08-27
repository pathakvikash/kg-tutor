import type { PrismaClient } from "@kg/db";
import type { LLMProvider } from "@kg/llm";

/** The control arm: keep it a fair baseline, on the strong tier with the same history. (14) */
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

  // Usage only, so the arms stay cost-comparable: no evidence, no mastery, no plan.
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
