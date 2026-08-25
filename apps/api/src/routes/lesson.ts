import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { completeJson } from "@kg/llm";
import { loadMastery } from "@kg/planner";
import { generateItems, selectItem, routeChatQuestion, recordEvidence } from "@kg/teach";
import { prisma, getLlm } from "../context.js";

const NO_MODEL = {
  error: "no model configured",
  detail: "Set LLM_PROVIDER=claude-code, or ANTHROPIC_API_KEY / OPENAI_API_KEY, then restart.",
};

const explanationSchema = z.object({
  hook: z.string(),
  explanation: z.string(),
  example: z.string(),
});

const EXPLAIN_SYSTEM = `You explain one concept to one learner.

You are given the concept, what it means, what the learner already knows, and any
misconception they hold about it. Adapt the framing, the analogy and the example to
their background — but do not invent claims about the concept itself.

If the learner already knows a related concept, bridge from it explicitly. That bridge
is the single most valuable thing you can do here.

Keep it to one sitting. Be concrete. No filler, no encouragement padding.

Respond with JSON: {"hook","explanation","example"}`;

export async function lessonRoutes(app: FastifyInstance): Promise<void> {
  /** Explanation for the concept about to be taught. Delivery is generated; the
   *  substance would come from stored content once a library exists. (12) */
  app.post("/api/lesson/explain", async (req, reply) => {
    const body = z.object({ learnerId: z.string(), conceptId: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const llm = getLlm();
    if (!llm) return reply.code(503).send(NO_MODEL);

    const concept = await prisma.concept.findUniqueOrThrow({ where: { id: body.data.conceptId } });
    const mastery = await loadMastery(prisma, body.data.learnerId);
    const known = await prisma.concept.findMany({
      where: { id: { in: [...mastery.entries()].filter(([, m]) => m !== "unknown").map(([id]) => id) } },
    });
    const misconceptions = await prisma.misconception.findMany({
      where: { learnerId: body.data.learnerId, conceptId: body.data.conceptId, resolvedAt: null },
    });
    const learner = await prisma.learner.findUniqueOrThrow({ where: { id: body.data.learnerId } });

    const out = await completeJson(
      llm,
      {
        system: EXPLAIN_SYSTEM,
        user: [
          `Concept: ${concept.canonicalName}`,
          `Meaning: ${concept.sense}`,
          learner.background ? `Learner background: ${learner.background}` : "",
          known.length > 0 ? `Already knows: ${known.map((k) => k.canonicalName).join(", ")}` : "",
          misconceptions.length > 0
            ? `Correct this belief they hold: ${misconceptions.map((m) => m.belief).join("; ")}`
            : "",
        ].filter(Boolean).join("\n"),
        tier: "strong",
        temperature: 0.5,
      },
      explanationSchema,
    );

    return { concept: { id: concept.id, name: concept.canonicalName, sense: concept.sense }, ...out };
  });

  /** The check that follows an explanation. Generates items on demand if none exist. */
  app.post("/api/lesson/check", async (req, reply) => {
    const body = z
      .object({
        learnerId: z.string(),
        conceptId: z.string(),
        level: z.enum(["familiar", "functional", "solid"]).default("functional"),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const llm = getLlm();
    if (!llm) return reply.code(503).send(NO_MODEL);

    let item = await selectItem(prisma, body.data.conceptId, body.data.level);
    if (!item) {
      await generateItems(prisma, llm, body.data.conceptId);
      item = await selectItem(prisma, body.data.conceptId, body.data.level);
    }
    if (!item) return reply.code(422).send({ error: "no item could be produced for this concept" });

    return {
      itemId: item.id,
      prompt: item.prompt,
      requiresTransfer: item.requiresTransfer,
      targetsLevel: item.targetsLevel,
    };
  });

  /**
   * A learner question mid-lesson. Chat never teaches — it routes, and only a named
   * prerequisite gap touches the learner model. (19)
   */
  app.post("/api/lesson/ask", async (req, reply) => {
    const body = z
      .object({ learnerId: z.string(), conceptId: z.string(), question: z.string().min(1) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const llm = getLlm();
    if (!llm) return reply.code(503).send(NO_MODEL);

    const concept = await prisma.concept.findUniqueOrThrow({ where: { id: body.data.conceptId } });
    const prereqs = await prisma.edge.findMany({
      where: { dstId: body.data.conceptId, type: "prerequisite_of", strength: "hard", retiredAt: null },
      include: { src: true },
    });

    const route = await routeChatQuestion(llm, {
      question: body.data.question,
      currentConceptName: concept.canonicalName,
      prerequisiteNames: prereqs.map((p) => ({ conceptId: p.srcId, name: p.src.canonicalName })),
    });

    // The learner named their own gap while attempting the target: the cleanest
    // missing-edge signal there is, and free of the usual selection confound. (19)
    if (route.intent === "prerequisite_gap") {
      await recordEvidence(prisma, {
        learnerId: body.data.learnerId,
        conceptId: body.data.conceptId,
        kind: "spontaneous_prerequisite_request",
        referencedConceptId: route.prerequisiteConceptId ?? undefined,
        response: body.data.question,
        detail: { namedConcept: route.namedConcept },
      });
    }

    const answer = await llm.complete({
      system:
        route.intent === "tangential"
          ? "Answer in two sentences. The learner is mid-lesson on something else, so be brief and offer to come back to this properly later."
          : "Answer the learner's question directly and concretely. Do not restate the whole lesson.",
      user: `They are learning "${concept.canonicalName}" (${concept.sense}).\nThey asked: ${body.data.question}`,
      tier: "small",
      temperature: 0.4,
    });

    return {
      intent: route.intent,
      answer,
      // The UI offers a detour rather than silently taking one.
      detourTo: route.intent === "prerequisite_gap" ? route.prerequisiteConceptId : null,
      namedConcept: route.namedConcept,
      reasoning: route.reasoning,
    };
  });
}
