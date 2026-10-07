import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { completeJson } from "@kg/llm";
import { activePlanWhere, reconcilePlan } from "@kg/planner";
import { atLeast } from "@kg/shared";
import { prisma, getLlm } from "../context.js";

const resolveSchema = z.object({
  /** subject = a body of knowledge; outcome = a capability or role */
  kind: z.enum(["subject", "outcome"]),
  canonicalName: z.string().min(1),
  description: z.string(),
  depth: z.enum(["use", "debug", "build"]),
  components: z.array(z.string()).default([]),
});

const RESOLVE_SYSTEM = `You turn a learner's stated goal into a structured target.

kind:
- "subject" for a body of knowledge ("JavaScript", "SQL", "linear algebra")
- "outcome" for a capability or role ("become a backend developer", "build a web app")

canonicalName: the goal as a topic name — title case, no verbs. "Become a backend
developer" becomes "Backend Development".

depth: infer from how they phrased it. "understand", "learn about" → use. "debug",
"know why it breaks" → debug. "master", "become a", "build with" → build.

components: for an outcome ONLY, the 3-6 subjects someone actually has to learn to
reach it. Real subjects that can be taught, not phases of a career.

Respond with JSON: {"kind","canonicalName","description","depth","components"}`;

export async function roadmapRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/roadmap/resolve", async (req, reply) => {
    const body = z.object({ goal: z.string().min(2) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const llm = getLlm();
    if (!llm) return reply.code(503).send({ error: "no model configured" });

    const parsed = await completeJson(
      llm,
      { system: RESOLVE_SYSTEM, user: `Goal: ${body.data.goal}`, tier: "small", temperature: 0 },
      resolveSchema,
    );

    const existing = await prisma.topic.findFirst({
      where: { name: { equals: parsed.canonicalName, mode: "insensitive" } },
      include: { _count: { select: { concepts: true } } },
    });

    return {
      ...parsed,
      topicId: existing?.id ?? null,
      conceptCount: existing?._count.concepts ?? 0,
      needsExpansion: !existing || existing._count.concepts === 0,
    };
  });

  app.post("/api/roadmap/outcome", async (req, reply) => {
    const body = z
      .object({
        canonicalName: z.string(),
        description: z.string(),
        components: z.array(z.string()),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const outcome = await prisma.topic.upsert({
      where: { name: body.data.canonicalName },
      create: { name: body.data.canonicalName, kind: "outcome", description: body.data.description },
      update: { kind: "outcome", description: body.data.description },
    });

    const components = [];
    for (const name of body.data.components) {
      const t = await prisma.topic.upsert({
        where: { name },
        create: { name, kind: "subject", description: `Part of ${body.data.canonicalName}.` },
        update: {},
      });
      const count = await prisma.topicConcept.count({ where: { topicId: t.id } });
      components.push({ id: t.id, name: t.name, conceptCount: count });
    }
    return { outcome: { id: outcome.id, name: outcome.name }, components };
  });

  app.get("/api/roadmap/:learnerId", async (req, reply) => {
    const { learnerId } = req.params as { learnerId: string };
    // Mastery reached outside a lesson still completes a step, so reconcile on read
    await reconcilePlan(prisma, learnerId);
    const plan = await prisma.plan.findFirst({
      where: activePlanWhere(learnerId),
      include: {
        goal: { include: { topic: true } },
        steps: { include: { concept: true }, orderBy: { position: "asc" } },
        milestones: {
          include: { template: { include: { concepts: { include: { concept: true } } } } },
          orderBy: { position: "asc" },
        },
      },
      orderBy: { version: "desc" },
    });
    if (!plan) return reply.code(404).send({ error: "no active plan" });

    const states = await prisma.learnerConceptState.findMany({ where: { learnerId } });
    const mastery = new Map(states.map((s) => [s.conceptId, s.mastery]));

    return {
      goal: { topic: plan.goal.topic.name, kind: plan.goal.topic.kind, depth: plan.goal.depth },
      version: plan.version,
      totalConcepts: plan.steps.length,
      completed: plan.steps.filter((s) => atLeast(mastery.get(s.conceptId) ?? "unknown", s.requiredLevel)).length,
      taught: plan.steps.filter((s) => s.completedAt).length,
      milestones: plan.milestones.map((m) => ({
        claim: m.template.claim,
        position: m.position,
        completed: m.completedAt !== null,
        foldedForward: m.foldedForward,
        concepts: m.template.concepts.map((c) => ({
          id: c.conceptId,
          name: c.concept.canonicalName,
          requiredLevel: c.requiredLevel,
          currentMastery: mastery.get(c.conceptId) ?? "unknown",
        })),
      })),
      steps: plan.steps.map((s) => ({
        conceptId: s.conceptId,
        name: s.concept.canonicalName,
        position: s.position,
        requiredLevel: s.requiredLevel,
        currentMastery: mastery.get(s.conceptId) ?? "unknown",
        completed: atLeast(mastery.get(s.conceptId) ?? "unknown", s.requiredLevel),
        unlockCount: s.unlockCount,
      })),
    };
  });
}
