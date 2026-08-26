import type { FastifyInstance } from "fastify";
import { LLMAuthError, LLMError } from "@kg/llm";

/**
 * A provider that will not serve us is not a server fault, and reporting it as one
 * buries the only actionable part. An expired login should say "sign in again", not
 * "Internal Server Error" over a wall of JSON.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
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
    req.log.error({ err }, "unhandled error");
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({
      error: status >= 500 ? "Something went wrong on our side." : err.message,
      kind: "server_error",
    });
  });
}
