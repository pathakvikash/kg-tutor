import { assignVariant } from "@kg/teach";
import { prisma } from "./context.js";

export type SessionKind = "lesson" | "review";

export async function openSession(
  learnerId: string,
  kind: SessionKind = "lesson",
): Promise<string> {
  const existing = await prisma.session.findFirst({
    where: { learnerId, kind, endedAt: null },
    orderBy: { startedAt: "desc" },
  });
  if (existing) return existing.id;
  const created = await prisma.session.create({
    data: { learnerId, kind, variant: assignVariant(learnerId) },
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
