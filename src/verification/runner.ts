import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import { execa, execaCommand } from "execa";
import type { ValidationCommand } from "../config/schema";
import type { CommandResult } from "../types";
import { sha256 } from "../util/hash";
import { BoundedCapture, redactText } from "./capture";

async function consume(
  stream: Readable | null,
  capture: BoundedCapture,
): Promise<void> {
  if (!stream) return;
  for await (const chunk of stream)
    capture.update(
      typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array),
    );
}

async function terminateProcessTree(
  pid: number | undefined,
  fallback: () => void,
): Promise<void> {
  if (pid === undefined) {
    fallback();
    return;
  }
  if (process.platform === "win32") {
    await execa("taskkill", ["/pid", String(pid), "/T", "/F"], {
      reject: false,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 500);
    });
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The process group already exited after SIGTERM.
    }
  } catch {
    fallback();
  }
}

export async function runVerificationCommand(options: {
  command: ValidationCommand;
  cwd: string;
  retainCharacters: number;
  now?: () => Date;
}): Promise<CommandResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const started = performance.now();
  const stdoutCapture = new BoundedCapture(options.retainCharacters);
  const stderrCapture = new BoundedCapture(options.retainCharacters);
  let exitCode: number | null = null;
  let signal: string | null = null;
  let status: CommandResult["status"];
  let timedOut: boolean;

  try {
    const subprocess = execaCommand(options.command.command, {
      cwd: options.cwd,
      shell: true,
      reject: false,
      buffer: false,
      detached: process.platform !== "win32",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = subprocess.stdout as Readable | null;
    const stderr = subprocess.stderr as Readable | null;
    const consumers = Promise.all([
      consume(stdout, stdoutCapture),
      consume(stderr, stderrCapture),
    ]);
    let timer: NodeJS.Timeout | undefined;
    const completed = subprocess.then((result) => ({
      kind: "completed" as const,
      result,
    }));
    const expired = new Promise<{ kind: "expired" }>((resolveExpired) => {
      timer = setTimeout(() => {
        resolveExpired({ kind: "expired" });
        void terminateProcessTree(subprocess.pid, () => {
          subprocess.kill("SIGKILL");
        });
      }, options.command.timeoutSeconds * 1000);
    });
    const outcome = await Promise.race([completed, expired]);
    timedOut = outcome.kind === "expired";
    if (timer !== undefined) clearTimeout(timer);
    const result =
      outcome.kind === "completed" ? outcome.result : await subprocess;
    await consumers;
    exitCode = timedOut ? null : (result.exitCode ?? null);
    signal = result.signal ?? null;
    status = timedOut
      ? "timed-out"
      : result.exitCode === 0
        ? "passed"
        : "failed";
  } catch (error) {
    stderrCapture.update(
      error instanceof Error ? error.message : String(error),
    );
    status = "spawn-error";
  }

  const finishedAt = now().toISOString();
  return {
    name: options.command.name,
    command: redactText(options.command.command),
    commandHash: sha256(options.command.command),
    startedAt,
    finishedAt,
    durationMs: Math.max(0, performance.now() - started),
    timeoutSeconds: options.command.timeoutSeconds,
    status,
    exitCode,
    signal,
    stdout: stdoutCapture.finish(),
    stderr: stderrCapture.finish(),
  };
}
