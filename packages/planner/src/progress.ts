import type { PrismaClient } from "@kg/db";
import { atLeast, type MasteryLevel } from "@kg/shared";
import { loadMastery } from "./plan.js";

/**
 * Reconciles the plan against what the learner actually knows.
 *
 * Plan steps used to be completed in exactly one place: the end of a lesson. But mastery
 * does not only arrive from lessons. Intake establishes it for concepts that are never
 * taught, a review probe can raise it, and teaching one concept can lift a prerequisite.
 * Every one of those left a step that the learner had satisfied but the plan still called
 * outstanding, which showed up three ways at once — a roadmap header reading 0% above
 * rows saying "done", milestones that could never complete, and "what's next" offering a
 * lesson on something already known.
 *
 * So completion is derived from mastery rather than recorded by whoever happened to
 * notice. `completedAt` keeps its real meaning — the moment the step became satisfied —
 * but nothing has to remember to set it.
 */
export async function reconcilePlan(
  prisma: PrismaClient,
  learnerId: string,
): Promise<{ steps: string[]; milestones: string[] }> {
  const plan = await prisma.plan.findFirst({
    where: { learnerId, supersededAt: null },
    include: {
      steps: true,
      milestones: { include: { template: { include: { concepts: true } } } },
    },
    orderBy: { version: "desc" },
  });
  if (!plan) return { steps: [], milestones: [] };

  const mastery = await loadMastery(prisma, learnerId);
  const met = (conceptId: string, required: MasteryLevel) =>
    atLeast(mastery.get(conceptId) ?? "unknown", required);

  const now = new Date();
  const steps: string[] = [];
  for (const s of plan.steps) {
    if (s.completedAt) continue;
    if (!met(s.conceptId, s.requiredLevel)) continue;
    await prisma.planStep.update({ where: { id: s.id }, data: { completedAt: now } });
    steps.push(s.conceptId);
  }

  const milestones: string[] = [];
  for (const m of plan.milestones) {
    if (m.completedAt) continue;
    // A milestone claiming no concepts is malformed, not satisfied. Treating it as met
    // would hand out a capability claim nobody demonstrated.
    if (m.template.concepts.length === 0) continue;
    if (!m.template.concepts.every((c) => met(c.conceptId, c.requiredLevel))) continue;
    await prisma.milestoneInstance.update({ where: { id: m.id }, data: { completedAt: now } });
    milestones.push(m.template.claim);
  }

  return { steps, milestones };
}
