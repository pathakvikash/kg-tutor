import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildPlan, reconcilePlan } from "@kg/planner";
import {
  applyAnswer, buildChains, derivedBeliefs, gradeResponse, initialState,
  loadTopicGraph, nextProbe, recordEvidence, selectItem, generateItems,
  type IntakeState, type ProbeChoice,
} from "@kg/teach";
import { prisma, getLlm } from "../context.js";

const NO_MODEL = { error: "no model configured", detail: "Choose one in Settings." };

/** Picks or generates the question for a probe. */
async function questionFor(
  conceptId: string,
): Promise<{ itemId: string; prompt: string; code: string | null; codeLanguage: string | null } | null> {
  const llm = getLlm();
  let item = await selectItem(prisma, conceptId, "functional");
  if (!item && llm) {
    await generateItems(prisma, llm, conceptId);
    item = await selectItem(prisma, conceptId, "functional");
  }
  return item
    ? { itemId: item.id, prompt: item.prompt, code: item.code, codeLanguage: item.codeLanguage }
    : null;
}

/**
 * What the last answer was judged to be, carried into the next response.
 *
 * The grader produces this on every answer and it was being dropped on the floor, so a
 * learner submitted four answers and was told nothing about any of them. Three of the
 * four were wrong, which is exactly the information an assessment exists to surface.
 */
export interface AnswerVerdict {
  conceptName: string;
  correct: boolean;
  reasoning: string;
}

async function advance(intakeId: string, lastAnswer?: AnswerVerdict): Promise<unknown> {
  const intake = await prisma.intakeSession.findUniqueOrThrow({ where: { id: intakeId } });
  const state = intake.state as unknown as IntakeState;
  const probe = nextProbe(state);

  if (!probe) return { ...(await finish(intakeId) as object), lastAnswer: lastAnswer ?? null };

  const q = await questionFor(probe.conceptId);
  if (!q) {
    // No item and no way to make one: skip rather than stalling the intake.
    const skipped = applyAnswer(state, probe, false);
    await prisma.intakeSession.update({
      where: { id: intakeId }, data: { state: skipped as never },
    });
    return advance(intakeId, lastAnswer);
  }

  const concept = await prisma.concept.findUniqueOrThrow({ where: { id: probe.conceptId } });
  // Deliberately not writing `state` here. `nextProbe` does not modify it, so this was a
  // read-modify-write of unchanged data — and `advance` runs on the resume GET as well as
  // after an answer. A GET that read the state before an answer landed would write that
  // stale copy back on top of it, and the answer vanished: graded, recorded, erased. The
  // question pointer below is the only thing this path legitimately changes.
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
      // Shown to the learner so a question about something unfamiliar does not feel
      // arbitrary — the point is to find where knowledge stops, not to catch anyone out.
      why: `Finding where your knowledge stops — this is step ${probe.position + 1} of ${probe.chainLength} in this chain.`,
    },
  };
}

/**
 * The active goal for this topic and depth, created if it does not exist yet.
 *
 * Shared by start and finish so both plan against the same goal: `buildPlan` supersedes
 * the previous plan for a goal and bumps the version, so reusing it turns the assessment
 * into a *revision* of the roadmap — v1 to v2 with a diff — instead of a second goal
 * with an unrelated plan hanging off it.
 */
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

/** Writes what the intake concluded into the learner model, then plans. (07) */
async function finish(intakeId: string): Promise<unknown> {
  const intake = await prisma.intakeSession.findUniqueOrThrow({ where: { id: intakeId } });
  const state = intake.state as unknown as IntakeState;
  const beliefs = derivedBeliefs(state);

  for (const b of beliefs) {
    if (b.mastery === "unknown") continue;
    await recordEvidence(prisma, {
      learnerId: intake.learnerId,
      conceptId: b.conceptId,
      // An inferred belief must not look like demonstrated mastery. (06)
      kind: b.source === "assessed" ? "applied" : "downstream_success",
    });
  }

  const goalId = await activeGoalFor(
    intake.learnerId, intake.topicId, intake.depth as "use" | "debug" | "build",
  );
  const plan = await buildPlan({ prisma, learnerId: intake.learnerId, goalId });
  // The intake just established mastery for concepts nobody will teach. Without this the
  // fresh plan opens at 0% with half its steps already satisfied.
  await reconcilePlan(prisma, intake.learnerId);

  await prisma.intakeSession.update({
    where: { id: intakeId },
    data: { status: "complete", currentConceptId: null, currentItemId: null },
  });

  // Named, not counted. "Found 3 concepts you already have" is not a result a learner
  // can check; "closures, scope, callbacks" is.
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
        /** Self-report. A prior on where to probe — never evidence of mastery. (07) */
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

    // Self-report is recorded as a low-confidence prior. It can redirect probing; it
    // can never cause a skip. (07)
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

    /**
     * The roadmap exists before a single question is answered.
     *
     * It was only built at the end, so a learner who asked for "a roadmap to master data
     * structures", waited out several minutes of graph building, and then met a run of
     * questions had nothing to show for any of it — the thing they asked for did not
     * exist yet and nothing said so. The graph is what the roadmap needs; the assessment
     * only decides what to *skip*. So plan now, and let the assessment revise it.
     */
    const goalId = await activeGoalFor(body.data.learnerId, body.data.topicId, body.data.depth);
    const provisional = await buildPlan({
      prisma, learnerId: body.data.learnerId, goalId,
      revisionReason: "first pass, before the assessment",
    });

    return {
      ...(await advance(intake.id) as object),
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

    const llm = getLlm();
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
      // The probe's snippet, which was being dropped here too.
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
    return advance(id, {
      conceptName: concept.canonicalName,
      correct: grade.correct,
      reasoning: grade.reasoning,
    });
  });

  /**
   * Resumes an assessment that was interrupted.
   *
   * The IntakeSession row survived a refresh all along; the UI just never looked for
   * it, so a reload silently restarted a half-finished assessment from the first
   * question. Progress that is stored but unreachable is not persisted in any sense
   * the user cares about.
   */
  /**
   * Is there an assessment to pick up, and if so, what is it asking?
   *
   * `withQuestion` is off by default because deriving the question is not free: it runs
   * the probe selection and, when a concept has no usable item, generates a fresh bank
   * on the strong tier. Two separate components ask this on mount purely to decide
   * whether to show the assessment at all, and each was paying for a question neither
   * of them read.
   */
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

    // Re-derive the current question rather than trusting a stored one: the item may
    // have been retired since.
    const resumed = await advance(intake.id);
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

  /** Every session for a learner, so past lessons are reachable rather than lost. */
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

  /**
   * Deleting a session removes its transcript, not what was learned from it.
   *
   * Evidence rows carry a nullable sessionId precisely so a transcript can be cleared
   * without rewriting history: mastery was earned, and forgetting the conversation
   * should not silently un-earn it.
   */
  app.delete("/api/sessions/:id", async (req, reply) => {
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

  app.delete("/api/learners/:id/sessions", async (req) => {
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

  /** Reopening a past session makes it the live one again. */
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
