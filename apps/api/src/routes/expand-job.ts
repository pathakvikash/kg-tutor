import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { expandTopicShallow } from "@kg/graph";
import { prisma, getLlm, resolverDeps } from "../context.js";

/** Expansion takes minutes, so it runs as a polled job rather than one long request. */
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
        // The partial report is written on every tick so the UI can render the graph so far.
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

/** Marks jobs stranded by a restart as failed; expansion is idempotent, so retry is manual. */
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
