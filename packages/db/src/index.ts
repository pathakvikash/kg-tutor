import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

let client: PrismaClient | undefined;

/** Single shared client; Prisma pools connections internally. */
export function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}
