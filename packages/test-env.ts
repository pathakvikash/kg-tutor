import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// These suites truncate every table, so the guard below must reject any other database.
const envPath = resolve(import.meta.dirname, "../.env.test");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
  if (m?.[1]) process.env[m[1]] = m[2];
}

const url = process.env.DATABASE_URL ?? "";
if (!/\/kg_tutor_test(\?|$)/.test(url)) {
  throw new Error(
    `refusing to run tests against ${url || "(unset)"} — the database name must be ` +
      `kg_tutor_test. Tests truncate every table.`,
  );
}
