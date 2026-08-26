import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { graphRoutes } from "./routes/graph.js";
import { learnerRoutes } from "./routes/learner.js";
import { reviewRoutes } from "./routes/review.js";
import { metricsRoutes } from "./routes/metrics.js";
import { teachRoutes } from "./routes/teach.js";
import { lessonRoutes, progressRoutes } from "./routes/lesson.js";
import { expandJobRoutes, failStrandedJobs } from "./routes/expand-job.js";
import { settingsRoutes } from "./routes/settings.js";
import { intakeRoutes } from "./routes/intake.js";
import { roadmapRoutes } from "./routes/roadmap.js";
import { widgetRoutes } from "./routes/widget.js";
import { providerStatus, refreshLlm } from "./context.js";
import { installErrorHandler } from "./errors.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, "../../web/dist");
const PORT = Number(process.env.PORT ?? 4000);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

// Several endpoints take no body. Fastify's default JSON parser rejects an empty one
// with a 400 before any handler runs, which is a confusing failure for a request that
// is perfectly valid.
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (_req, body, done) => {
    const text = (body as string).trim();
    if (text.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

installErrorHandler(app);

await app.register(graphRoutes);
await app.register(learnerRoutes);
await app.register(reviewRoutes);
await app.register(metricsRoutes);
await app.register(teachRoutes);
await app.register(lessonRoutes);
await app.register(progressRoutes);
await app.register(expandJobRoutes);
await app.register(settingsRoutes);
await app.register(intakeRoutes);
await app.register(roadmapRoutes);
await app.register(widgetRoutes);

if (existsSync(join(webDist, "index.html"))) {
  await app.register(fastifyStatic, { root: webDist });
  // SPA fallback: anything not an API route serves the app shell.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    return reply.sendFile("index.html");
  });
} else {
  app.get("/", async () => ({
    message: "API is up. The web app is not built — run `pnpm --filter @kg/web build`.",
    ...providerStatus(),
  }));
}

await refreshLlm();

// Jobs are in-process promises; a restart strands them mid-flight.
const stranded = await failStrandedJobs();
if (stranded > 0) {
  app.log.warn({ stranded }, "marked expansion jobs stranded by a restart as failed");
}
const status = providerStatus();
app.log.info(
  { llm: status.llm ?? "none", embedding: status.embedding },
  status.degraded
    ? "running with stub providers — expansion and teaching endpoints return 503"
    : "live providers configured",
);

await app.listen({ port: PORT, host: "127.0.0.1" });
