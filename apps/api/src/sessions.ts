import { assignVariant } from "@kg/teach";
import { prisma } from "./context.js";

/**
 * Session and transcript writes, shared by every route that produces a turn.
 *
 * These lived inside the lesson routes, so the grading endpoint — which is in a
 * different file — had no way to record anything. It recorded nothing: not the learner's
 * answer, not the verdict. The client pushed both into local state, then refreshed from
 * the transcript, and the screen reverted to the moment before the answer was given.
 */
export async function openSession(learnerId: string): Promise<string> {
  const existing = await prisma.session.findFirst({
    where: { learnerId, endedAt: null },
    orderBy: { startedAt: "desc" },
  });
  if (existing) return existing.id;
  const created = await prisma.session.create({
    data: { learnerId, variant: assignVariant(learnerId) },
  });
  return created.id;
}

export async function saveTurn(
  sessionId: string,
  learnerId: string,
  conceptId: string | null,
  role: string,
  text: string,
  meta?: unknown,
): Promise<void> {
  await prisma.lessonTurn.create({
    data: { sessionId, learnerId, conceptId, role, text, meta: (meta ?? null) as never },
  });
}
