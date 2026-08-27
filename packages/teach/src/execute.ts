import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExecuteRequest {
  code: string;
  /** Appended after the learner's code; usually assertions. */
  harness?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface ExecuteResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  durationMs: number;
}

const MAX_OUTPUT = 16_000;

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…output truncated` : s;
}

/** Isolation, not a sandbox: hostile code still reaches the filesystem and the network. (16) */
export async function executeJs(req: ExecuteRequest): Promise<ExecuteResult> {
  const timeoutMs = req.timeoutMs ?? 5_000;
  const dir = await mkdtemp(join(tmpdir(), "kg-exec-"));
  const file = join(dir, "main.mjs");
  const started = Date.now();

  try {
    await writeFile(file, `${req.code}\n${req.harness ?? ""}\n`, "utf8");

    return await new Promise<ExecuteResult>((resolve) => {
      const child = spawn(process.execPath, ["--no-warnings", file], {
        cwd: dir,
        // A stripped environment: no API keys, no DATABASE_URL, nothing inherited.
        env: { PATH: "/usr/bin:/bin", NODE_ENV: "sandbox" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT * 2) stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        if (stderr.length < MAX_OUTPUT * 2) stderr += d.toString();
      });

      const timer = setTimeout(() => {
        timedOut = true;
        // Kill the group, not just the child — a spawned grandchild would outlive it.
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs);

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: !timedOut && exitCode === 0,
          stdout: clip(stdout),
          stderr: clip(timedOut ? `${stderr}\nExecution timed out after ${timeoutMs}ms.` : stderr),
          timedOut,
          exitCode,
          durationMs: Date.now() - started,
        });
      };

      child.on("error", (err) => {
        stderr += `\nfailed to start: ${err.message}`;
        finish(null);
      });
      child.on("close", finish);
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
