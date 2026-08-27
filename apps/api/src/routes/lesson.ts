import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { completeJson, startStream } from "@kg/llm";
import { activePlanWhere, loadMastery } from "@kg/planner";
import { generateItems, isWrongLanguage, selectItem, routeChatQuestion, recordEvidence } from "@kg/teach";
import { isActionable } from "@kg/teach";
import { prisma, getLlm } from "../context.js";
import { openSession, saveTurn } from "../sessions.js";

/** Six most recent turns, oldest first, so follow-up questions have a referent. */
async function recentTurns(sessionId: string): Promise<string> {
  const turns = await prisma.lessonTurn.findMany({
    where: { sessionId, role: { in: ["learner", "tutor"] } },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  if (turns.length === 0) return "";
  // Attribution has to survive: a learner mistake must not read as an established fact.
  return turns
    .reverse()
    .map((t) =>
      t.role === "learner"
        ? `LEARNER SAID (their words, may contain mistakes): ${t.text.slice(0, 600)}`
        : `YOU REPLIED: ${t.text.slice(0, 600)}`,
    )
    .join("\n");
}

const NO_MODEL = {
  error: "no model configured",
  detail: "Set LLM_PROVIDER=claude-code, or ANTHROPIC_API_KEY / OPENAI_API_KEY, then restart.",
};

/** Code gets its own field so the model never has to embed a fence in prose. */
const explanationSchema = z.object({
  hook: z.string(),
  explanation: z.string(),
  example: z.object({
    language: z.string().default("javascript"),
    code: z.string(),
    walkthrough: z.string(),
  }),
});

const EXPLAIN_SYSTEM = `You explain one concept to one learner.

You are given the concept, what it means, what the learner already knows, and any
misconception they hold about it. Adapt the framing, the analogy and the example to
their background — but do not invent claims about the concept itself.

If the learner already knows a related concept, bridge from it explicitly. That bridge
is the single most valuable thing you can do here.

Keep it to one sitting. Be concrete. No filler, no encouragement padding.

FORMAT — the explanation field is rendered as markdown, so write markdown:

- Short paragraphs. Three or four sentences, then a break. A wall of prose is the most
  common way a good explanation goes unread.
- Use "## " subheadings when the explanation has more than one distinct part.
- Use a bulleted or numbered list whenever you are enumerating things. Never bury a
  list inside a sentence.
- ANY code — an expression, a method call, a signature — goes in a fenced block with a
  language tag, or in \`backticks\` if it is a single identifier mid-sentence. Never
  write code as prose. "You attach with promise.then(onSuccess)" is wrong; show it.
- Bold the two or three phrases that carry the idea. Not more.
- Never draw ASCII or box-drawing diagrams. If something needs a picture, say so in one
  sentence — the system renders a real interactive one separately.

Put runnable code in example.code as PLAIN CODE — no markdown fences, no backticks.
example.language is its language. example.walkthrough explains what the code shows, in
prose. Prose fields may use markdown (bold, inline code, lists); the code field may not.

Respond with JSON: {"hook","explanation","example":{"language","code","walkthrough"}}`;

/** Shared by both answer paths. */
const ANSWER_SYSTEM = `Answer the learner's question directly and concretely. Do not restate the whole lesson.

Your answer is rendered as markdown. Write markdown:

- Lead with the answer. No preamble, no restating the question back.
- Short paragraphs, three or four sentences at most.
- Enumerating things? Use a list. Comparing things? Use a table.
- ANY code goes in a fenced block with a language tag (\`\`\`javascript), or in
  \`backticks\` for a single identifier mid-sentence. Never write code as prose.
- Bold only the phrase that carries the point.
- Never draw ASCII or box-drawing diagrams. If the answer wants a picture, say so in
  one sentence — an interactive one is rendered separately.`;

export async function lessonRoutes(app: FastifyInstance): Promise<void> {
  /** Explanation for the concept being taught; generated until a content library exists. (12) */
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

    const explainTopics = await prisma.topicConcept.findMany({
      where: { conceptId: concept.id },
      include: { topic: true },
    });

    const out = await completeJson(
      llm,
      {
        system: EXPLAIN_SYSTEM,
        user: [
          `Concept: ${concept.canonicalName}`,
          `Meaning: ${concept.sense}`,
          explainTopics.length > 0
            ? `Studied as part of: ${explainTopics.map((t) => t.topic.name).join(", ")}`
            : "",
          learner.workingLanguage
            ? `They write code in ${learner.workingLanguage} — use it for every example.`
            : "",
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

    const sessionId = await openSession(body.data.learnerId);

    // Persisted as a candidate so the promotion pipeline has something to promote.
    const bucket = [learner.background ?? "none", concept.canonicalName].join("|").slice(0, 120);
    const content = await prisma.explanationContent.create({
      data: {
        conceptId: concept.id,
        claims: out.explanation,
        examples: [out.example] as never,
        bucket,
        status: "candidate",
        timesShown: 1,
      },
    });

    await saveTurn(sessionId, body.data.learnerId, concept.id, "system",
      `Now teaching: ${concept.canonicalName}`);
    await saveTurn(sessionId, body.data.learnerId, concept.id, "tutor", out.hook, {
      kind: "hook", contentId: content.id,
    });
    await saveTurn(sessionId, body.data.learnerId, concept.id, "tutor", out.explanation, {
      kind: "explanation", contentId: content.id,
    });
    await saveTurn(sessionId, body.data.learnerId, concept.id, "code", out.example.code, {
      kind: "example", language: out.example.language, contentId: content.id,
    });
    await saveTurn(sessionId, body.data.learnerId, concept.id, "tutor", out.example.walkthrough, {
      kind: "walkthrough", contentId: content.id,
    });

    return {
      concept: { id: concept.id, name: concept.canonicalName, sense: concept.sense },
      sessionId,
      contentId: content.id,
      ...out,
    };
  });

  /** Everything said in the learner's open session, so a reload resumes rather than resets. */
  app.get("/api/lesson/:learnerId/transcript", async (req) => {
    const { learnerId } = req.params as { learnerId: string };
    const session = await prisma.session.findFirst({
      // The lesson transcript is the lesson's, so a review pass cannot appear in it.
      where: { learnerId, kind: "lesson", endedAt: null },
      orderBy: { startedAt: "desc" },
    });
    if (!session) return { sessionId: null, turns: [] };
    const turns = await prisma.lessonTurn.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "asc" },
    });
    return { sessionId: session.id, turns };
  });

  /** Ends the open session, so "start over" is explicit rather than a lost reload. */
  app.post("/api/lesson/:learnerId/reset", async (req) => {
    const { learnerId } = req.params as { learnerId: string };
    await prisma.session.updateMany({
      where: { learnerId, endedAt: null },
      data: { endedAt: new Date() },
    });
    return { ok: true };
  });

  /** The check that follows an explanation. Generates items on demand if none exist. */
  app.post("/api/lesson/check", async (req, reply) => {
    const body = z
      .object({
        learnerId: z.string(),
        conceptId: z.string(),
        level: z.enum(["familiar", "functional", "solid"]).default("functional"),
        /** Which transcript the question lands in; the answered-since scan reads it. */
        kind: z.enum(["lesson", "review"]).default("lesson"),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const llm = getLlm();
    if (!llm) return reply.code(503).send(NO_MODEL);

    const learner = await prisma.learner.findUniqueOrThrow({
      where: { id: body.data.learnerId },
      select: { workingLanguage: true },
    });
    const language = learner.workingLanguage;

    let item = await selectItem(prisma, body.data.conceptId, body.data.level, [], { language });
    // Regenerate when the bank only has items in a language the learner does not write.
    if (!item || isWrongLanguage(item, language)) {
      await generateItems(prisma, llm, body.data.conceptId, { language });
      item = await selectItem(prisma, body.data.conceptId, body.data.level, [], { language });
    }
    if (!item) return reply.code(422).send({ error: "no item could be produced for this concept" });

    const sessionId = await openSession(body.data.learnerId, body.data.kind);
    await saveTurn(sessionId, body.data.learnerId, body.data.conceptId, "question", item.prompt, {
      itemId: item.id,
      requiresTransfer: item.requiresTransfer,
      code: item.code,
      codeLanguage: item.codeLanguage,
    });

    return {
      itemId: item.id,
      prompt: item.prompt,
      code: item.code,
      codeLanguage: item.codeLanguage,
      requiresTransfer: item.requiresTransfer,
      targetsLevel: item.targetsLevel,
      sessionId,
    };
  });

  /** Streaming answer path: a routed event lands first, then text deltas. */
  app.post("/api/lesson/ask/stream", async (req, reply) => {
    const body = z
      .object({ learnerId: z.string(), conceptId: z.string(), question: z.string().min(1) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const llm = getLlm();
    if (!llm) return reply.code(503).send(NO_MODEL);

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const concept = await prisma.concept.findUniqueOrThrow({
        where: { id: body.data.conceptId },
      });
      const prereqs = await prisma.edge.findMany({
        where: {
          dstId: body.data.conceptId, type: "prerequisite_of",
          strength: "hard", retiredAt: null,
        },
        include: { src: true },
      });

      // Routing and the answer have no data dependency, so they run concurrently.
      const sessionId = await openSession(body.data.learnerId);
      const history = await recentTurns(sessionId);

      const answer$ = startStream(llm, {
        system: ANSWER_SYSTEM,
        user: [
          `They are learning "${concept.canonicalName}" (${concept.sense}).`,
          history
            ? `Earlier in this conversation (their statements are not established facts —\ncheck them before building on them):\n${history}`
            : "",
          `They asked: ${body.data.question}`,
        ].filter(Boolean).join("\n"),
        tier: "small",
        temperature: 0.4,
      });

      await saveTurn(sessionId, body.data.learnerId, concept.id, "learner", body.data.question);

      // The client needs this before any delta arrives, or early deltas are dropped.
      send("open", { sessionId });

      // Routing reports when it lands instead of holding the answer text back.
      const routing = routeChatQuestion(llm, {
        question: body.data.question,
        currentConceptName: concept.canonicalName,
        prerequisiteNames: prereqs.map((p) => ({ conceptId: p.srcId, name: p.src.canonicalName })),
      }).then(async (route) => {
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
        send("routed", {
          sessionId,
          intent: route.intent,
          action: isActionable(route.intent) ? "start_roadmap" : null,
          goalText: isActionable(route.intent) ? route.namedConcept ?? body.data.question : null,
          suggestVisual: route.wantsVisual,
          detourTo: route.intent === "prerequisite_gap" ? route.prerequisiteConceptId : null,
          namedConcept: route.namedConcept,
        });
        return route;
      });

      let answer = "";
      const pump = (async () => {
        for await (const chunk of answer$.chunks) {
          answer += chunk;
          send("delta", { text: chunk });
        }
      })();

      const [route] = await Promise.all([routing, pump]);

      // Saved only once complete: a half-written answer is not a turn worth resuming.
      await saveTurn(sessionId, body.data.learnerId, concept.id, "tutor", answer, {
        intent: route.intent,
      });
      send("done", { answer });
    } catch (err) {
      send("failed", {
        error: err instanceof Error ? err.message : String(err),
        remedy: (err as { remedy?: string }).remedy ?? null,
      });
    } finally {
      reply.raw.end();
    }
  });

  /** A learner question mid-lesson: chat routes, it never teaches. (19) */
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

    const sessionId = await openSession(body.data.learnerId);
    const history = await recentTurns(sessionId);

    const route = await routeChatQuestion(llm, {
      question: body.data.question,
      currentConceptName: concept.canonicalName,
      prerequisiteNames: prereqs.map((p) => ({ conceptId: p.srcId, name: p.src.canonicalName })),
    });

    // A request to learn something else is acted on, not answered.
    if (isActionable(route.intent)) {
      await saveTurn(sessionId, body.data.learnerId, body.data.conceptId, "learner", body.data.question);
      return {
        sessionId,
        intent: route.intent,
        action: "start_roadmap",
        goalText: route.namedConcept ?? body.data.question,
        answer: null,
        detourTo: null,
        namedConcept: route.namedConcept,
        reasoning: route.reasoning,
      };
    }

    // The learner naming their own gap is the cleanest missing-edge signal. (19)
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
      user: [
        `They are learning "${concept.canonicalName}" (${concept.sense}).`,
        history
          ? `Earlier in this conversation (their statements are not established facts —\ncheck them before building on them):\n${history}`
          : "",
        `They asked: ${body.data.question}`,
      ].filter(Boolean).join("\n"),
      tier: "small",
      temperature: 0.4,
    });

    await saveTurn(sessionId, body.data.learnerId, body.data.conceptId, "learner", body.data.question);
    await saveTurn(sessionId, body.data.learnerId, body.data.conceptId, "tutor", answer, {
      intent: route.intent,
    });

    return {
      sessionId,
      intent: route.intent,
      // The client follows up with a widget call rather than two model calls at once.
      suggestVisual: route.wantsVisual,
      answer,
      // The UI offers a detour rather than silently taking one.
      detourTo: route.intent === "prerequisite_gap" ? route.prerequisiteConceptId : null,
      namedConcept: route.namedConcept,
      reasoning: route.reasoning,
    };
  });
}

/** Advancing the plan once a step reaches its required level. */
export async function progressRoutes(app: import("fastify").FastifyInstance): Promise<void> {
  app.post("/api/learners/:id/steps/:conceptId/complete", async (req, reply) => {
    const { id, conceptId } = req.params as { id: string; conceptId: string };
    const plan = await prisma.plan.findFirst({
      where: activePlanWhere(id),
      include: { steps: true, milestones: { include: { template: { include: { concepts: true } } } } },
      orderBy: { version: "desc" },
    });
    if (!plan) return reply.code(404).send({ error: "no active plan" });

    const step = plan.steps.find((s) => s.conceptId === conceptId);
    if (!step) return reply.code(404).send({ error: "concept is not on the active plan" });

    const state = await prisma.learnerConceptState.findUnique({
      where: { learnerId_conceptId: { learnerId: id, conceptId } },
    });
    const { atLeast } = await import("@kg/shared");
    // Completion is earned by evidence, not asserted by the client.
    if (!state || !atLeast(state.mastery, step.requiredLevel)) {
      return reply.code(422).send({
        error: "not yet at the required level",
        have: state?.mastery ?? "unknown",
        need: step.requiredLevel,
      });
    }

    // One reconciler, so a finished lesson and a finished intake advance the plan alike.
    const { reconcilePlan } = await import("@kg/planner");
    const { milestones: completedMilestones } = await reconcilePlan(prisma, id);

    return { completed: conceptId, completedMilestones };
  });
}
