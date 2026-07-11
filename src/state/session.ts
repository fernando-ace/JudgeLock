import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ACTIVE_RECEIPT_FILE,
  CONFIG_FILE,
  ExitCode,
  JUDGELOCK_VERSION,
  SESSION_FILE,
} from "../constants";
import { parseConfig } from "../config/load";
import type { JudgeLockConfig } from "../config/schema";
import { JudgeLockError } from "../errors";
import { GitClient } from "../git/client";
import { repositoryIdentifier } from "../git/state";
import type {
  ActiveReceiptPointer,
  SessionFileV1,
  SessionPayloadV1,
} from "../types";
import { atomicWriteJson } from "../util/atomic";
import { digestPayload, hasValidDigest, sha256 } from "../util/hash";
import { ActiveReceiptPointerSchema, SessionFileSchema } from "./schema";

export interface TrustedSessionContext {
  git: GitClient;
  session: SessionPayloadV1;
  config: JudgeLockConfig;
  policyBytes: Buffer;
}

function absolute(root: string, relativePath: string): string {
  return join(root, ...relativePath.split("/"));
}

export async function createSession(options: {
  git: GitClient;
  task: string;
  baselineCommit: string;
  policyBytes: Buffer;
  now?: Date;
}): Promise<SessionPayloadV1> {
  const { git, task, baselineCommit, policyBytes } = options;
  const createdAt = (options.now ?? new Date()).toISOString();
  const sessionPath = absolute(git.root, SESSION_FILE);
  try {
    await readFile(sessionPath);
    const archiveDirectory = absolute(git.root, ".judgelock/sessions");
    await mkdir(archiveDirectory, { recursive: true });
    const archived = join(
      archiveDirectory,
      `superseded-${createdAt.replaceAll(":", "-")}-${basename(sessionPath)}`,
    );
    await rename(sessionPath, archived);
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") {
      const quarantineDirectory = absolute(git.root, ".judgelock/quarantine");
      await mkdir(quarantineDirectory, { recursive: true });
      await rename(
        sessionPath,
        join(quarantineDirectory, `session-${String(Date.now())}.json`),
      ).catch(() => undefined);
    }
  }
  await invalidateActiveReceipt(git.root);

  const session: SessionPayloadV1 = {
    schemaVersion: 1,
    sessionId: randomUUID(),
    task: task.trim(),
    createdAt,
    repositoryId: await repositoryIdentifier(git, baselineCommit),
    baselineCommit,
    policySourceCommit: baselineCommit,
    policyPath: CONFIG_FILE,
    trustedPolicyHash: sha256(policyBytes),
    judgeLockVersion: JUDGELOCK_VERSION,
  };
  await atomicWriteJson(sessionPath, digestPayload(session));
  return session;
}

export async function loadSession(
  root: string,
  allowMissing = false,
): Promise<SessionPayloadV1 | null> {
  const path = absolute(root, SESSION_FILE);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" && allowMissing) return null;
    if (code === "ENOENT") {
      throw new JudgeLockError("No active JudgeLock session exists.", {
        code: "NO_ACTIVE_SESSION",
        exitCode: ExitCode.PRECONDITION_FAILED,
        remediation:
          "Run 'judgelock start --task \"...\"' from a clean baseline.",
      });
    }
    throw new JudgeLockError("The active JudgeLock session state is corrupt.", {
      code: "SESSION_STATE_CORRUPT",
      exitCode: ExitCode.STATE_CORRUPT,
      remediation:
        "Run 'judgelock start' explicitly to quarantine and replace the damaged session.",
      cause: error,
    });
  }
  const parsed = SessionFileSchema.safeParse(value);
  if (!parsed.success || !hasValidDigest(parsed.data as SessionFileV1)) {
    throw new JudgeLockError(
      "The active JudgeLock session state is invalid or its digest does not match.",
      {
        code: "SESSION_STATE_CORRUPT",
        exitCode: ExitCode.STATE_CORRUPT,
        remediation:
          "Run 'judgelock start' explicitly to replace the damaged session.",
      },
    );
  }
  return parsed.data.payload;
}

export async function loadTrustedSessionContext(
  cwd: string,
): Promise<TrustedSessionContext> {
  const git = await GitClient.discover(cwd);
  const session = await loadSession(git.root);
  if (!session) throw new Error("unreachable");
  const policyBytes = await git.showFile(
    session.policySourceCommit,
    session.policyPath,
  );
  if (!policyBytes || sha256(policyBytes) !== session.trustedPolicyHash) {
    throw new JudgeLockError(
      "The trusted session policy cannot be reproduced from Git.",
      {
        code: "TRUSTED_POLICY_MISMATCH",
        exitCode: ExitCode.STATE_CORRUPT,
        remediation: "Start a new session from a clean, committed policy.",
      },
    );
  }
  const repositoryId = await repositoryIdentifier(git, session.baselineCommit);
  if (repositoryId !== session.repositoryId) {
    throw new JudgeLockError(
      "The active session belongs to a different Git repository.",
      {
        code: "SESSION_REPOSITORY_MISMATCH",
        exitCode: ExitCode.STATE_CORRUPT,
      },
    );
  }
  return {
    git,
    session,
    config: parseConfig(
      policyBytes.toString("utf8"),
      `${session.policySourceCommit}:${CONFIG_FILE}`,
    ),
    policyBytes,
  };
}

export async function invalidateActiveReceipt(root: string): Promise<void> {
  await rm(absolute(root, ACTIVE_RECEIPT_FILE), { force: true });
}

export async function writeActiveReceiptPointer(
  root: string,
  pointer: ActiveReceiptPointer,
): Promise<void> {
  await atomicWriteJson(absolute(root, ACTIVE_RECEIPT_FILE), pointer);
}

export async function readActiveReceiptPointer(
  root: string,
): Promise<ActiveReceiptPointer | null> {
  try {
    const value: unknown = JSON.parse(
      await readFile(absolute(root, ACTIVE_RECEIPT_FILE), "utf8"),
    );
    const parsed = ActiveReceiptPointerSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid active receipt pointer.");
    return parsed.data;
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return null;
    throw new JudgeLockError("The active receipt pointer is corrupt.", {
      code: "RECEIPT_POINTER_CORRUPT",
      exitCode: ExitCode.STATE_CORRUPT,
      cause: error,
    });
  }
}
