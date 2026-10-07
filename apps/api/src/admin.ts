import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export const isProduction = (): boolean => process.env.NODE_ENV === "production";

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Sends the refusal and returns false unless the bearer token matches ADMIN_TOKEN */
export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    if (!isProduction()) return true;
    void reply.code(403).send({ error: "admin actions are disabled: ADMIN_TOKEN is not set" });
    return false;
  }
  const given = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
  if (sameToken(given, expected)) return true;
  void reply.code(403).send({ error: "admin token required" });
  return false;
}
