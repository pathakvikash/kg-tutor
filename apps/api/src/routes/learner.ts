import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { activePlanWhere, buildPlan, loadMastery, reconcilePlan } from "@kg/planner";
import { atLeast } from "@kg/shared";
import { selectProbes, assignVariant, dueForReview } from "@kg/teach";
import { prisma } from "../context.js";

export async function learnerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/learners", async () => {
    const learners = await prisma.learner.findMany({
      include: { _count: { select: { states: true, evidence: true, goals: true } } },
      orderBy: { createdAt: "desc" },
    });
    return learners.map((l) => ({
      id: l.id,
      email: l.email,
      name: l.name,
      background: l.background,
      workingLanguage: l.workingLanguage,
      variant: assignVariant(l.id),
      concepts: l._count.states,
      evidence: l._count.evidence,
      goals: l._count.goals,
    }));
  });

  app.post("/api/learners", async (req, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        name: z.string().optional(),
        background: z.string().optional(),
        workingLanguage: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const l = await prisma.learner.create({
      data: {
        email: body.data.email,
        name: body.data.name ?? null,
        background: body.data.background ?? null,
        workingLanguage: body.data.workingLanguage ?? null,
      },
    });
    return { ...l, variant: assignVariant(l.id) };
  });

  /** Editing who the learner is. Only the fields that steer teaching. */
  app.patch("/api/learners/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        name: z.string().nullable().optional(),
        background: z.string().nullable().optional(),
        /** Empty string clears it, which is different from leaving it unset. */
        workingLanguage: z.string().nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const data: Record<string, string | null> = {};
    if (body.data.name !== undefined) data.name = body.data.name || null;
    if (body.data.background !== undefined) data.background = body.data.background || null;
    if (body.data.workingLanguage !== undefined) {
      data.workingLanguage = body.data.workingLanguage?.trim() || null;
    }

    const updated = await prisma.learner.update({ where: { id }, data });
    return {
      id: updated.id, name: updated.name,
      background: updated.background, workingLanguage: updated.workingLanguage,
    };
  });

  app.get("/api/learners/:id/state", async (req, reply) => {
    const { id } = req.params as { id: string };
    const learner = await prisma.learner.findUnique({ where: { id } });
    if (!learner) return reply.code(404).send({ error: "learner not found" });

    const [states, misconceptions, goals] = await Promise.all([
      prisma.learnerConceptState.findMany({
        where: { learnerId: id },
        include: { concept: true },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.misconception.findMany({
        where: { learnerId: id, resolvedAt: null },
        include: { concept: true },
      }),
      prisma.goal.findMany({ where: { learnerId: id }, include: { topic: true } }),
    ]);

    return {
      learner: { ...learner, variant: assignVariant(learner.id) },
      states: states.map((s) => ({
        conceptId: s.conceptId,
        name: s.concept.canonicalName,
        mastery: s.mastery,
        confidence: s.confidence,
        source: s.source,
        lastEvidenceAt: s.lastEvidenceAt,
        reprobeQueued: s.reprobeQueuedAt !== null,
        blockedUntil: s.blockedUntil,
      })),
      misconceptions: misconceptions.map((m) => ({
        conceptId: m.conceptId,
        name: m.concept.canonicalName,
        belief: m.belief,
        matchedFailureMode: m.matchedFailureMode,
      })),
      goals: goals.map((g) => ({
        id: g.id,
        topic: g.topic.name,
        topicId: g.topicId,
        depth: g.depth,
        active: g.active,
      })),
    };
  });

  app.post("/api/learners/:id/goals", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ topicId: z.string(), depth: z.enum(["use", "debug", "build"]) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    // One active plan at a time — the teaching engine needs a single path. (08)
    await prisma.goal.updateMany({ where: { learnerId: id, active: true }, data: { active: false } });
    const goal = await prisma.goal.create({
      data: { learnerId: id, topicId: body.data.topicId, depth: body.data.depth, active: true },
    });
    const plan = await buildPlan({ prisma, learnerId: id, goalId: goal.id });
    return { goal, plan };
  });

  /** What this learner owes attention to, plan or no plan; also where misconceptions surface. */
  app.get("/api/learners/:id/due", async (req) => {
    const { id } = req.params as { id: string };
    const limit = Number((req.query as { limit?: string }).limit ?? 20);
    // Count the whole queue before slicing, so total reports the backlog and not the cap.
    const all = await dueForReview(prisma, id);
    const items = all.slice(0, Math.min(Math.max(limit, 1), 50));
    return {
      total: all.length,
      returned: items.length,
      truncated: all.length > items.length,
      // Counted over the whole queue, to match `total`.
      byKind: {
        misconception: all.filter((i) => i.kind === "misconception").length,
        inferred: all.filter((i) => i.kind === "inferred").length,
        decayed: all.filter((i) => i.kind === "decayed").length,
      },
      items,
    };
  });

  app.post("/api/learners/:id/plan/rebuild", async (req, reply) => {
    const { id } = req.params as { id: string };
    const goal = await prisma.goal.findFirst({ where: { learnerId: id, active: true } });
    if (!goal) return reply.code(400).send({ error: "no active goal" });
    return buildPlan({ prisma, learnerId: id, goalId: goal.id });
  });

  /** The learner's path: plan steps, milestones and the probes due before the next step. */
  app.get("/api/learners/:id/plan", async (req, reply) => {
    const { id } = req.params as { id: string };
    await reconcilePlan(prisma, id);
    const plan = await prisma.plan.findFirst({
      where: activePlanWhere(id),
      include: {
        goal: { include: { topic: true } },
        steps: { include: { concept: true }, orderBy: { position: "asc" } },
        milestones: { include: { template: { include: { concepts: true } } }, orderBy: { position: "asc" } },
      },
      orderBy: { version: "desc" },
    });
    if (!plan) return reply.code(404).send({ error: "no active plan" });

    const mastery = await loadMastery(prisma, id);
    // The next step is the first one not yet mastered, not the first one left unmarked.
    const nextStep = plan.steps.find(
      (s) => !atLeast(mastery.get(s.conceptId) ?? "unknown", s.requiredLevel),
    );

    const probes = nextStep
      ? await selectProbes({
          prisma,
          learnerId: id,
          nextConceptId: nextStep.conceptId,
          reviewProbesUsedThisSession: 0,
        })
      : [];

    const names = new Map(plan.steps.map((s) => [s.conceptId, s.concept.canonicalName]));

    return {
      planId: plan.id,
      version: plan.version,
      revisionReason: plan.revisionReason,
      goal: { topic: plan.goal.topic.name, depth: plan.goal.depth },
      steps: plan.steps.map((s) => ({
        conceptId: s.conceptId,
        name: s.concept.canonicalName,
        position: s.position,
        requiredLevel: s.requiredLevel,
        committed: s.committed,
        unlockCount: s.unlockCount,
        currentMastery: mastery.get(s.conceptId) ?? "unknown",
        completed: atLeast(mastery.get(s.conceptId) ?? "unknown", s.requiredLevel),
      })),
      milestones: plan.milestones.map((m) => ({
        id: m.id,
        claim: m.template.claim,
        position: m.position,
        foldedForward: m.foldedForward,
        completed: m.completedAt !== null,
        conceptCount: m.template.concepts.length,
      })),
      probes: probes.map((p) => ({
        conceptId: p.conceptId,
        name: names.get(p.conceptId) ?? p.conceptId,
        kind: p.kind,
        optional: p.optional,
        reason: p.reason,
      })),
    };
  });
}
