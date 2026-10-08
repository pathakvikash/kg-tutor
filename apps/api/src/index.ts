import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
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
import { llmRoutes } from "./routes/llm.js";
import { resolveLlm, type LLMProvider } from "@kg/llm";
import { getLlm, providerStatus, refreshLlm } from "./context.js";
import { installErrorHandler } from "./errors.js";
import { isProduction } from "./admin.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, "../../web/dist");
const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? (isProduction() ? "0.0.0.0" : "127.0.0.1");
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);
const RATE_LLM_MAX = Number(process.env.RATE_LIMIT_LLM_MAX ?? 10);
const CORS_ORIGINS = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Routes that spend model tokens; method + path as registered
const LLM_ROUTES = new Set([
  "POST /api/lesson/explain",
  "POST /api/lesson/check",
  "POST /api/lesson/ask",
  "POST /api/lesson/ask/stream",
  "POST /api/lesson/widget",
  "POST /api/intake/start",
  "POST /api/topics/expand",
  "POST /api/concepts/:id/deepen",
  "POST /api/concepts/:id/items/generate",
  "POST /api/learners/:id/attempt",
  "POST /api/learners/:id/chat",
  "POST /api/intake/:id/answer",
  "POST /api/roadmap/resolve",
  "POST /api/expansions",
  "POST /api/expansions/:id/retry",
  "POST /api/llm/models",
  "POST /api/llm/test",
]);

// Hops of proxy in front of the API; 0 locally so x-forwarded-for cannot be spoofed
const trustProxy = Number(process.env.TRUST_PROXY ?? 0);

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: ['req.headers["x-llm-config"]', "req.headers.authorization"],
  },
  trustProxy: trustProxy > 0 ? trustProxy : false,
});

await app.register(cors, {
  origin: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : false,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  maxAge: 600,
});
// Registered before the plugin, whose own onRoute hook reads this config
app.addHook("onRoute", (route) => {
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  if (methods.some((m) => LLM_ROUTES.has(`${m} ${route.url}`))) {
    route.config = { ...route.config, rateLimit: { max: RATE_LLM_MAX, timeWindow: "1 minute" } };
  }
});
await app.register(rateLimit, { max: RATE_MAX, timeWindow: "1 minute" });

// The default JSON parser 400s on an empty body, and several endpoints take none
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

declare module "fastify" {
  interface FastifyRequest {
    llm: LLMProvider | null;
  }
}
app.decorateRequest("llm", null);
// preHandler, not onRequest: runs after rate-limit, so spam cannot drive DNS lookups
app.addHook("preHandler", async (req) => {
  const header = req.headers["x-llm-config"];
  req.llm = await resolveLlm(typeof header === "string" ? header : undefined, getLlm);
});

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
await app.register(llmRoutes);

if (existsSync(join(webDist, "index.html"))) {
  await app.register(fastifyStatic, { root: webDist });
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

await app.listen({ port: PORT, host: HOST });
