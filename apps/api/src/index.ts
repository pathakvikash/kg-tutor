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
import { providerStatus } from "./context.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, "../../web/dist");
const PORT = Number(process.env.PORT ?? 4000);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

await app.register(graphRoutes);
await app.register(learnerRoutes);
await app.register(reviewRoutes);
await app.register(metricsRoutes);
await app.register(teachRoutes);

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

const status = providerStatus();
app.log.info(
  { llm: status.llm ?? "none", embedding: status.embedding },
  status.degraded
    ? "running with stub providers — expansion and teaching endpoints return 503"
    : "live providers configured",
);

await app.listen({ port: PORT, host: "127.0.0.1" });
