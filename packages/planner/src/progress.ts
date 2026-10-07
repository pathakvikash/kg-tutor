import type { PrismaClient } from "@kg/db";
import { atLeast, type MasteryLevel } from "@kg/shared";
import { activePlanWhere, loadMastery } from "./plan.js";

export async function reconcilePlan(
  prisma: PrismaClient,
  learnerId: string,
): Promise<{ steps: string[]; milestones: string[] }> {
  const plan = await prisma.plan.findFirst({
    where: activePlanWhere(learnerId),
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
    if (m.template.concepts.length === 0) continue;
    if (!m.template.concepts.every((c) => met(c.conceptId, c.requiredLevel))) continue;
    await prisma.milestoneInstance.update({ where: { id: m.id }, data: { completedAt: now } });
    milestones.push(m.template.claim);
  }

  return { steps, milestones };
}
