import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { expandTopicShallow } from "@kg/graph";
import { prisma, getLlm, resolverDeps } from "../context.js";

/**
 * Expansion makes dozens of sequential model calls and takes minutes. Holding an HTTP
 * request open for that is a bad experience and a fragile one — a dropped connection
 * loses work that has already been paid for. It runs as a job the UI polls instead.
 */
async function runJob(jobId: string): Promise<void> {
  const job = await prisma.expansionJob.findUniqueOrThrow({ where: { id: jobId } });
  const llm = getLlm();
  const resolver = resolverDeps();

  if (!llm || !resolver) {
    await prisma.expansionJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        error: "No model configured. Set LLM_PROVIDER=claude-code or an API key.",
        finishedAt: new Date(),
      },
    });
    return;
  }

  await prisma.expansionJob.update({
    where: { id: jobId },
    data: { status: "running", phase: "finding concepts", progress: 0.05, startedAt: new Date() },
  });

  try {
    const report = await expandTopicShallow({
      topicName: job.topicName,
      ...(job.description ? { topicDescription: job.description } : {}),
      llm,
      prisma,
      resolver,
      onProgress: (phase, progress, partial) => {
        // The partial report is written on every tick so the UI can render the graph
        // being built rather than a percentage that means nothing to a learner.
        void prisma.expansionJob
          .update({ where: { id: jobId }, data: { phase, progress, report: partial as never } })
          .catch(() => undefined);
      },
    });
    await prisma.expansionJob.update({
      where: { id: jobId },
      data: {
        status: "done", phase: "complete", progress: 1,
        report: report as never, finishedAt: new Date(),
      },
    });
  } catch (err) {
    await prisma.expansionJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      },
    });
  }
}

/**
 * A job runs as an in-process promise, so a restart strands it in `running` forever.
 *
 * These are marked failed on boot rather than silently retried: expansion IS idempotent
 * — every concept goes back through the resolver and binds to what already exists — so
 * re-running is safe and cheap, but auto-retrying a job that might have crashed the
 * process would loop. Better to say plainly what happened and let the user click again.
 */
export async function failStrandedJobs(): Promise<number> {
  const { count } = await prisma.expansionJob.updateMany({
    where: { status: { in: ["queued", "running"] } },
    data: {
      status: "failed",
      error:
        "Interrupted by a server restart. Nothing was lost — concepts already written " +
        "are kept, and starting this topic again picks up from there rather than " +
        "duplicating them.",
      finishedAt: new Date(),
    },
  });
  return count;
}

export async function expandJobRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/expansions", async (req, reply) => {
    const body = z
      .object({ topicName: z.string().min(1), description: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const existing = await prisma.expansionJob.findFirst({
      where: { topicName: body.data.topicName, status: { in: ["queued", "running"] } },
    });
    if (existing) return existing;

    const job = await prisma.expansionJob.create({
      data: { topicName: body.data.topicName, description: body.data.description ?? null },
    });
    // Deliberately not awaited: the response returns the job id immediately.
    void runJob(job.id);
    return job;
  });

  app.get("/api/expansions", async () =>
    prisma.expansionJob.findMany({ orderBy: { createdAt: "desc" }, take: 20 }));

  /** Re-runs a failed or interrupted job. Safe: the resolver dedups everything. */
  app.post("/api/expansions/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const old = await prisma.expansionJob.findUnique({ where: { id } });
    if (!old) return reply.code(404).send({ error: "job not found" });
    const job = await prisma.expansionJob.create({
      data: { topicName: old.topicName, description: old.description },
    });
    void runJob(job.id);
    return job;
  });

  app.get("/api/expansions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await prisma.expansionJob.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "job not found" });
    return job;
  });
}
