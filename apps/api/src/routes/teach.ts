import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { expandPrerequisitesOf, expandTopicShallow, type ExpandReport } from "@kg/graph";
import { executeJs, routeChatQuestion, runAttempt, selectItem, generateItems } from "@kg/teach";
import { prisma, getLlm, resolverDeps } from "../context.js";
import { openSession, saveTurn } from "../sessions.js";

const NO_MODEL = {
  error: "no model configured",
  detail:
    "Set ANTHROPIC_API_KEY or OPENAI_API_KEY and restart the API. " +
    "This endpoint deliberately has no mock: fabricated graph content is worse than a clear failure.",
};

export async function teachRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/topics/expand", async (req, reply) => {
    const body = z
      .object({ topicName: z.string().min(1), topicDescription: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const llm = getLlm();
    const resolver = resolverDeps();
    if (!llm || !resolver) return reply.code(503).send(NO_MODEL);

    return expandTopicShallow({
      topicName: body.data.topicName,
      ...(body.data.topicDescription ? { topicDescription: body.data.topicDescription } : {}),
      llm,
      prisma,
      resolver,
    });
  });

  /**
   * One more level of prerequisites under a single concept.
   *
   * A topic expansion goes one level deep and takes minutes, so the graph's depth is
   * whatever that first pass happened to produce — there was no way to say "go further
   * here" short of re-running the whole thing. Runs the identical pass a full expansion
   * uses, so the consensus filter, the name check and the cycle rejection all still apply.
   */
  app.post("/api/concepts/:id/deepen", async (req, reply) => {
    const { id } = req.params as { id: string };
    const llm = getLlm();
    const resolver = resolverDeps();
    if (!llm || !resolver) return reply.code(503).send(NO_MODEL);

    const concept = await prisma.concept.findUnique({
      where: { id },
      include: { topics: { include: { topic: true } } },
    });
    if (!concept) return reply.code(404).send({ error: "no such concept" });
    if (concept.deprecatedAt) {
      return reply.code(422).send({ error: "that concept has been deprecated" });
    }
    const home = concept.topics[0]?.topic;
    if (!home) return reply.code(422).send({ error: "that concept belongs to no topic" });

    const before = await prisma.edge.count({
      where: { dstId: id, type: "prerequisite_of", retiredAt: null },
    });
    // Judged against everything already in the topic, so a prerequisite that exists is
    // reused rather than duplicated.
    const siblings = await prisma.topicConcept.findMany({
      where: { topicId: home.id },
      select: { conceptId: true },
    });

    const report: ExpandReport = {
      topicId: home.id,
      conceptsCreated: 0, conceptsBound: 0, edgesWritten: 0, edgesDemoted: 0,
      edgesRejectedAsCycle: 0,
      conceptsDroppedByConsensus: [], prerequisitesDroppedByConsensus: [],
      conceptsWithFailedPrerequisites: [], namesRejected: [],
      milestones: [], milestonesRejected: [],
      conceptsFound: [], events: [],
    };

    await expandPrerequisitesOf(
      { id: concept.id, name: concept.canonicalName, sense: concept.sense },
      {
        prisma, llm, resolver,
        topicId: home.id,
        topicName: home.name,
        neighbourIds: siblings.map((s) => s.conceptId),
      },
      report,
    );

    const after = await prisma.edge.count({
      where: { dstId: id, type: "prerequisite_of", retiredAt: null },
    });
    return {
      concept: { id: concept.id, name: concept.canonicalName },
      topic: home.name,
      prerequisitesBefore: before,
      prerequisitesAfter: after,
      conceptsCreated: report.conceptsCreated,
      conceptsReused: report.conceptsBound,
      edgesWritten: report.edgesWritten,
      edgesDemoted: report.edgesDemoted,
      edgesRejectedAsCycle: report.edgesRejectedAsCycle,
      namesRejected: report.namesRejected,
      droppedByConsensus: report.prerequisitesDroppedByConsensus,
      events: report.events,
    };
  });

  app.post("/api/concepts/:id/items/generate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const llm = getLlm();
    if (!llm) return reply.code(503).send(NO_MODEL);
    return generateItems(prisma, llm, id);
  });

  app.get("/api/concepts/:id/next-item", async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { level?: string };
    const item = await selectItem(
      prisma,
      id,
      (q.level as "familiar" | "functional" | "solid") ?? "functional",
    );
    return item ?? { item: null };
  });

  app.post("/api/learners/:id/attempt", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        conceptId: z.string(),
        prompt: z.string(),
        response: z.string(),
        requiresTransfer: z.boolean().default(false),
        itemId: z.string().optional(),
        sessionId: z.string().optional(),
        /** Only used when sessionId is absent; see openSession. */
        kind: z.enum(["lesson", "review"]).default("lesson"),
        reexplanationsUsed: z.number().int().default(0),
        detoursUsedInChain: z.number().int().default(0),
        detourDepth: z.number().int().default(0),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const llm = getLlm();
    if (!llm) return reply.code(503).send(NO_MODEL);

    const sessionId = body.data.sessionId ?? (await openSession(id, body.data.kind));

    /**
     * The stored item wins over whatever the client sent.
     *
     * The client only ever held the prompt text, so a question about a snippet arrived
     * for grading with the snippet missing. Reading the row also means the prompt and
     * rubric being graded against are the ones the item bank actually records, rather
     * than a string that made a round trip through the browser.
     */
    const item = body.data.itemId
      ? await prisma.assessmentItem.findUnique({ where: { id: body.data.itemId } })
      : null;

    const result = await runAttempt({
      prisma,
      llm,
      prompt: item?.prompt ?? body.data.prompt,
      code: item?.code ?? null,
      codeLanguage: item?.codeLanguage ?? null,
      response: body.data.response,
      requiresTransfer: item?.requiresTransfer ?? body.data.requiresTransfer,
      ctx: {
        learnerId: id,
        conceptId: body.data.conceptId,
        itemId: body.data.itemId,
        sessionId,
        reexplanationsUsed: body.data.reexplanationsUsed,
        detoursUsedInChain: body.data.detoursUsedInChain,
        detourDepth: body.data.detourDepth,
      },
    });

    // The answer and the verdict are turns like any other. Without these the transcript
    // held the question and then jumped to the next one, so refreshing after grading
    // erased what the learner had just written and the feedback they had just been
    // given — the work disappeared and the screen went back a step.
    await saveTurn(sessionId, id, body.data.conceptId, "learner", body.data.response, {
      itemId: body.data.itemId ?? null,
    });
    await saveTurn(
      sessionId, id, body.data.conceptId, "tutor",
      `${result.grade.correct ? "**Correct.**" : "**Not quite.**"} ${result.grade.reasoning}`,
      { kind: "grade", correct: result.grade.correct },
    );

    return { ...result, sessionId };
  });

  app.post("/api/learners/:id/chat", async (req, reply) => {
    const body = z
      .object({ question: z.string(), currentConceptId: z.string() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const llm = getLlm();
    if (!llm) return reply.code(503).send(NO_MODEL);

    const concept = await prisma.concept.findUniqueOrThrow({
      where: { id: body.data.currentConceptId },
    });
    const prereqs = await prisma.edge.findMany({
      where: {
        dstId: body.data.currentConceptId,
        type: "prerequisite_of",
        strength: "hard",
        retiredAt: null,
      },
      include: { src: true },
    });

    return routeChatQuestion(llm, {
      question: body.data.question,
      currentConceptName: concept.canonicalName,
      prerequisiteNames: prereqs.map((p) => ({ conceptId: p.srcId, name: p.src.canonicalName })),
    });
  });

  /** Runs learner code. Not a security sandbox — see the note in @kg/teach/execute. */
  app.post("/api/execute", async (req, reply) => {
    const body = z
      .object({ code: z.string(), harness: z.string().optional(), timeoutMs: z.number().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    return executeJs(body.data);
  });
}
