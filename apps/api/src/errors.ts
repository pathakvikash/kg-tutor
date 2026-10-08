import type { FastifyInstance } from "fastify";
import { ByokConfigError, LLMAuthError, LLMError } from "@kg/llm";

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ByokConfigError) {
      return reply.code(400).send({ error: err.message, kind: "llm_config" });
    }
    if (err.name === "TimeoutError") {
      req.log.warn("model provider timed out");
      return reply.code(504).send({
        error: "The model provider did not answer in time.",
        kind: "provider_timeout",
      });
    }
    if (err instanceof LLMAuthError) {
      req.log.warn({ err: err.message }, "model provider rejected the request");
      return reply.code(503).send({
        error: err.message,
        remedy: err.remedy,
        kind: "provider_auth",
      });
    }
    if (err instanceof LLMError) {
      req.log.warn({ err: err.message }, "model call failed");
      return reply.code(502).send({ error: err.message, kind: "provider_error" });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status === 429) req.log.info("rate limited");
    else req.log.error({ err }, "unhandled error");
    return reply.code(status).send({
      error: status >= 500 ? "Something went wrong on our side." : err.message,
      kind: "server_error",
    });
  });
}
