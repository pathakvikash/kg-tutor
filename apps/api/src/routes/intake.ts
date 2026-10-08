import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildPlan, reconcilePlan } from "@kg/planner";
import {
  applyAnswer, buildChains, derivedBeliefs, gradeResponse, initialState,
  loadTopicGraph, nextProbe, recordEvidence, selectItem, generateItems, isWrongLanguage,
  type IntakeState, type ProbeChoice,
} from "@kg/teach";
import type { LLMProvider } from "@kg/llm";
import { prisma } from "../context.js";
import { requireAdmin } from "../admin.js";

const NO_MODEL = { error: "no model configured", detail: "Add your API key in Settings." };

async function questionFor(
  conceptId: string,
  llm: LLMProvider | null,
  language?: string | null,
): Promise<{ itemId: string; prompt: string; code: string | null; codeLanguage: string | null } | null> {
  let item = await selectItem(prisma, conceptId, "functional", [], { language });
  if ((!item || isWrongLanguage(item, language)) && llm) {
    await generateItems(prisma, llm, conceptId, { language });
    item = await selectItem(prisma, conceptId, "functional", [], { language });
  }
  return item
    ? { itemId: item.id, prompt: item.prompt, code: item.code, codeLanguage: item.codeLanguage }
    : null;
}

export interface AnswerVerdict {
  conceptName: string;
  correct: boolean;
  reasoning: string;
}

async function advance(
  intakeId: string,
  llm: LLMProvider | null,
  lastAnswer?: AnswerVerdict,
): Promise<unknown> {
  const intake = await prisma.intakeSession.findUniqueOrThrow({ where: { id: intakeId } });
  const state = intake.state as unknown as IntakeState;
  const probe = nextProbe(state);

  if (!probe) return { ...(await finish(intakeId) as object), lastAnswer: lastAnswer ?? null };

  const learner = await prisma.learner.findUnique({
    where: { id: intake.learnerId },
    select: { workingLanguage: true },
  });
  const q = await questionFor(probe.conceptId, llm, learner?.workingLanguage);
  if (!q) {
    const skipped = applyAnswer(state, probe, false);
    await prisma.intakeSession.update({
      where: { id: intakeId }, data: { state: skipped as never },
    });
    return advance(intakeId, llm, lastAnswer);
  }

  const concept = await prisma.concept.findUniqueOrThrow({ where: { id: probe.conceptId } });
  // Never write state here: a resume GET would put a stale copy over a fresh answer
  await prisma.intakeSession.update({
    where: { id: intakeId },
    data: { currentConceptId: probe.conceptId, currentItemId: q.itemId },
  });

  return {
    intakeId,
    status: "asking",
    asked: state.asked.length,
    budget: 8,
    lastAnswer: lastAnswer ?? null,
    question: {
      conceptId: probe.conceptId,
      conceptName: concept.canonicalName,
      itemId: q.itemId,
      prompt: q.prompt,
      code: q.code,
      codeLanguage: q.codeLanguage,
      why: `Finding where your knowledge stops — this is step ${probe.position + 1} of ${probe.chainLength} in this chain.`,
    },
  };
}

async function activeGoalFor(
  learnerId: string, topicId: string, depth: "use" | "debug" | "build",
): Promise<string> {
  const existing = await prisma.goal.findFirst({
    where: { learnerId, topicId, depth, active: true },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing.id;
  await prisma.goal.updateMany({ where: { learnerId, active: true }, data: { active: false } });
  const created = await prisma.goal.create({
    data: { learnerId, topicId, depth, active: true },
  });
  return created.id;
}

async function finish(intakeId: string): Promise<unknown> {
  const intake = await prisma.intakeSession.findUniqueOrThrow({ where: { id: intakeId } });
  const state = intake.state as unknown as IntakeState;
  const beliefs = derivedBeliefs(state);

  for (const b of beliefs) {
    if (b.mastery === "unknown") continue;
    await recordEvidence(prisma, {
      learnerId: intake.learnerId,
      conceptId: b.conceptId,
      // An inferred belief must not look like demonstrated mastery
      kind: b.source === "assessed" ? "applied" : "downstream_success",
    });
  }

  const goalId = await activeGoalFor(
    intake.learnerId, intake.topicId, intake.depth as "use" | "debug" | "build",
  );
  const plan = await buildPlan({ prisma, learnerId: intake.learnerId, goalId });
  // Reconcile now, or the fresh plan opens with already-satisfied steps still pending
  await reconcilePlan(prisma, intake.learnerId);

  await prisma.intakeSession.update({
    where: { id: intakeId },
    data: { status: "complete", currentConceptId: null, currentItemId: null },
  });

  const knownIds = beliefs.filter((b) => b.mastery !== "unknown").map((b) => b.conceptId);
  const knownConcepts = await prisma.concept.findMany({
    where: { id: { in: knownIds } },
    select: { id: true, canonicalName: true },
  });
  const firstStep = plan.steps[0]
    ? await prisma.concept.findUnique({
        where: { id: plan.steps[0].conceptId },
        select: { canonicalName: true },
      })
    : null;

  return {
    intakeId,
    status: "complete",
    asked: state.asked.length,
    known: knownIds.length,
    knownConcepts: knownConcepts.map((c) => c.canonicalName),
    startsWith: firstStep?.canonicalName ?? null,
    plan: { version: plan.version, steps: plan.steps.length, milestones: plan.milestones.length },
  };
}

export async function intakeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/intake/start", async (req, reply) => {
    const body = z
      .object({
        learnerId: z.string(),
        topicId: z.string(),
        depth: z.enum(["use", "debug", "build"]),
        goalText: z.string().optional(),
        alreadyKnow: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const { conceptIds, edges } = await loadTopicGraph(prisma, body.data.topicId);
    if (conceptIds.length === 0) {
      return reply.code(422).send({ error: "that topic has no concepts yet — expand it first" });
    }

    await prisma.intakeSession.updateMany({
      where: { learnerId: body.data.learnerId, status: "asking" },
      data: { status: "abandoned" },
    });

    const intake = await prisma.intakeSession.create({
      data: {
        learnerId: body.data.learnerId,
        topicId: body.data.topicId,
        depth: body.data.depth,
        goalText: body.data.goalText ?? null,
        state: initialState(buildChains(conceptIds, edges)) as never,
      },
    });

    // Self-report is a low-confidence prior: it can redirect probing, never cause a skip
    if (body.data.alreadyKnow?.trim()) {
      const named = await prisma.concept.findMany({
        where: { id: { in: conceptIds } },
      });
      const claim = body.data.alreadyKnow.toLowerCase();
      for (const c of named) {
        if (!claim.includes(c.canonicalName.toLowerCase())) continue;
        await recordEvidence(prisma, {
          learnerId: body.data.learnerId, conceptId: c.id, kind: "self_reported_skip",
        });
      }
    }

    const goalId = await activeGoalFor(body.data.learnerId, body.data.topicId, body.data.depth);
    const provisional = await buildPlan({
      prisma, learnerId: body.data.learnerId, goalId,
      revisionReason: "first pass, before the assessment",
    });

    return {
      ...(await advance(intake.id, req.llm) as object),
      plan: {
        version: provisional.version,
        steps: provisional.steps.length,
        milestones: provisional.milestones.length,
      },
    };
  });

  app.post("/api/intake/:id/answer", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ answer: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const llm = req.llm;
    if (!llm) return reply.code(503).send(NO_MODEL);

    const intake = await prisma.intakeSession.findUniqueOrThrow({ where: { id } });
    if (intake.status !== "asking" || !intake.currentConceptId) {
      return reply.code(409).send({ error: "this intake is not waiting for an answer" });
    }

    const concept = await prisma.concept.findUniqueOrThrow({
      where: { id: intake.currentConceptId },
    });
    const item = intake.currentItemId
      ? await prisma.assessmentItem.findUnique({ where: { id: intake.currentItemId } })
      : null;
    const prereqs = await prisma.edge.findMany({
      where: {
        dstId: concept.id, type: "prerequisite_of", strength: "hard", retiredAt: null,
      },
      include: { src: true },
    });

    const grade = await gradeResponse(llm, {
      prompt: item?.prompt ?? "",
      code: item?.code ?? null,
      codeLanguage: item?.codeLanguage ?? null,
      response: body.data.answer,
      conceptName: concept.canonicalName,
      requiresTransfer: item?.requiresTransfer ?? false,
      failureModes: prereqs
        .filter((p) => p.failureMode)
        .map((p) => ({
          edgeId: p.id, prerequisiteName: p.src.canonicalName, failureMode: p.failureMode!,
        })),
    });

    const state = intake.state as unknown as IntakeState;
    const chain = state.chains.findIndex((c) => c.ids.includes(concept.id));
    const position = state.chains[chain]?.ids.indexOf(concept.id) ?? 0;
    const probe: ProbeChoice = {
      conceptId: concept.id,
      chainIndex: chain < 0 ? 0 : chain,
      position,
      chainLength: state.chains[chain]?.ids.length ?? 1,
    };

    await prisma.intakeSession.update({
      where: { id },
      data: { state: applyAnswer(state, probe, grade.correct) as never },
    });
    return advance(id, llm, {
      conceptName: concept.canonicalName,
      correct: grade.correct,
      reasoning: grade.reasoning,
    });
  });

  app.get("/api/intake/open/:learnerId", async (req) => {
    const { learnerId } = req.params as { learnerId: string };
    const withQuestion = (req.query as { withQuestion?: string }).withQuestion === "1";
    const intake = await prisma.intakeSession.findFirst({
      where: { learnerId, status: "asking" },
      orderBy: { createdAt: "desc" },
    });
    if (!intake) return { intake: null };

    const topic = await prisma.topic.findUnique({ where: { id: intake.topicId } });
    const head = { intake: { id: intake.id, topic: topic?.name ?? null, depth: intake.depth } };
    if (!withQuestion) return { ...head, intakeId: intake.id, status: intake.status };

    const resumed = await advance(intake.id, req.llm);
    return { ...head, ...(resumed as object) };
  });

  app.post("/api/intake/:id/abandon", async (req) => {
    const { id } = req.params as { id: string };
    await prisma.intakeSession.update({ where: { id }, data: { status: "abandoned" } });
    return { ok: true };
  });

  app.get("/api/intake/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const intake = await prisma.intakeSession.findUnique({ where: { id } });
    if (!intake) return reply.code(404).send({ error: "not found" });
    const state = intake.state as unknown as IntakeState;
    return { ...intake, asked: state.asked.length };
  });

  app.get("/api/learners/:id/sessions", async (req) => {
    const { id } = req.params as { id: string };
    const sessions = await prisma.session.findMany({
      where: { learnerId: id },
      include: { _count: { select: { turns: true, evidence: true } } },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
    const out = [];
    for (const s of sessions) {
      const first = await prisma.lessonTurn.findFirst({
        where: { sessionId: s.id, role: "system" },
        orderBy: { createdAt: "asc" },
      });
      out.push({
        id: s.id,
        variant: s.variant,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        open: s.endedAt === null,
        turns: s._count.turns,
        evidence: s._count.evidence,
        title: first?.text ?? "Untitled session",
      });
    }
    return out;
  });

  app.get("/api/sessions/:id/transcript", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) return reply.code(404).send({ error: "session not found" });
    const turns = await prisma.lessonTurn.findMany({
      where: { sessionId: id }, orderBy: { createdAt: "asc" },
    });
    return { sessionId: id, open: session.endedAt === null, turns };
  });

  app.delete("/api/sessions/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) return reply.code(404).send({ error: "session not found" });

    const result = await prisma.$transaction(async (tx) => {
      const detached = await tx.evidenceEvent.updateMany({
        where: { sessionId: id }, data: { sessionId: null },
      });
      const turns = await tx.lessonTurn.deleteMany({ where: { sessionId: id } });
      await tx.plannerDecision.deleteMany({ where: { sessionId: id } });
      await tx.session.delete({ where: { id } });
      return { turnsDeleted: turns.count, evidenceKept: detached.count };
    });
    return result;
  });

  app.delete("/api/learners/:id/sessions", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const sessions = await prisma.session.findMany({ where: { learnerId: id }, select: { id: true } });
    const ids = sessions.map((s) => s.id);
    if (ids.length === 0) return { sessionsDeleted: 0, evidenceKept: 0 };

    return prisma.$transaction(async (tx) => {
      const detached = await tx.evidenceEvent.updateMany({
        where: { sessionId: { in: ids } }, data: { sessionId: null },
      });
      await tx.lessonTurn.deleteMany({ where: { sessionId: { in: ids } } });
      await tx.plannerDecision.deleteMany({ where: { sessionId: { in: ids } } });
      await tx.session.deleteMany({ where: { id: { in: ids } } });
      return { sessionsDeleted: ids.length, evidenceKept: detached.count };
    });
  });

  app.post("/api/sessions/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) return reply.code(404).send({ error: "session not found" });
    await prisma.session.updateMany({
      where: { learnerId: session.learnerId, endedAt: null, id: { not: id } },
      data: { endedAt: new Date() },
    });
    await prisma.session.update({ where: { id }, data: { endedAt: null } });
    return { ok: true, sessionId: id };
  });
}
