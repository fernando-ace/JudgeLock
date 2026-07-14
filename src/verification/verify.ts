import { ExitCode, JUDGELOCK_VERSION } from "../constants";
import { parseConfig } from "../config/load";
import type { JudgeLockConfig } from "../config/schema";
import { JudgeLockError } from "../errors";
import { GitClient } from "../git/client";
import { repositoryIdentifier } from "../git/state";
import { inspectRepository } from "../policy/inspect";
import { writeReceipt } from "../receipts/store";
import {
  invalidateActiveReceipt,
  loadTrustedSessionContext,
  writeActiveReceiptPointer,
} from "../state/session";
import type {
  CommandResult,
  ReceiptPayloadV1,
  VerificationReceiptV1,
} from "../types";
import { sha256 } from "../util/hash";
import { runVerificationCommand } from "./runner";

export interface VerificationRunResult {
  passed: boolean;
  evidenceValid: boolean;
  inspectionOnly: boolean;
  completionAuthorized: boolean;
  receiptPath: string;
  receipt: VerificationReceiptV1;
  failureKind?: "policy" | "command" | "state-changed" | "inspection-only";
}

async function executeCommands(options: {
  config: JudgeLockConfig;
  root: string;
  continueOnFailure: boolean;
}): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const command of options.config.validation.commands) {
    const result = await runVerificationCommand({
      command,
      cwd: options.root,
      retainCharacters: options.config.receipt.retainCommandOutputCharacters,
    });
    results.push(result);
    if (result.status !== "passed" && !options.continueOnFailure) break;
  }
  return results;
}

function buildPayload(options: {
  mode: "local" | "ci";
  repositoryId: string;
  baselineCommit: string;
  policySourceCommit: string;
  trustedPolicyHash: string;
  inspection: Awaited<ReturnType<typeof inspectRepository>>["inspection"];
  commands: CommandResult[];
  startedAt: string;
  sessionId?: string;
  task?: string;
  failureReason?: string;
}): ReceiptPayloadV1 {
  const finishedAt = new Date().toISOString();
  const commandFailure = options.commands.some(
    (command) => command.status !== "passed",
  );
  const failed =
    options.inspection.status === "blocked" ||
    commandFailure ||
    options.failureReason !== undefined;
  return {
    schemaVersion: 1,
    judgeLockVersion: JUDGELOCK_VERSION,
    mode: options.mode,
    ...(options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId }),
    ...(options.task === undefined ? {} : { task: options.task }),
    repositoryId: options.repositoryId,
    baselineCommit: options.baselineCommit,
    policySourceCommit: options.policySourceCommit,
    currentHead: options.inspection.currentHead,
    trustedPolicyHash: options.trustedPolicyHash,
    repositoryStateFingerprint: options.inspection.repositoryStateFingerprint,
    changedFiles: options.inspection.changedFiles,
    inspection: options.inspection,
    commands: options.commands,
    startedAt: options.startedAt,
    finishedAt,
    durationMs: Math.max(
      0,
      Date.parse(finishedAt) - Date.parse(options.startedAt),
    ),
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    finalStatus: failed
      ? "failed"
      : options.commands.length === 0
        ? "inspection_only"
        : "passed",
    ...(options.failureReason === undefined
      ? {}
      : { failureReason: options.failureReason }),
  };
}

export async function verifyLocal(
  cwd: string,
  continueOnFailure: boolean,
): Promise<VerificationRunResult> {
  const startedAt = new Date().toISOString();
  const context = await loadTrustedSessionContext(cwd);
  await invalidateActiveReceipt(context.git.root);
  const before = await inspectRepository({
    git: context.git,
    baselineCommit: context.session.baselineCommit,
    policySourceCommit: context.session.policySourceCommit,
    trustedPolicyHash: context.session.trustedPolicyHash,
    config: context.config,
    mode: "local",
  });

  let commands: CommandResult[] = [];
  if (before.inspection.status === "passed") {
    commands = await executeCommands({
      config: context.config,
      root: context.git.root,
      continueOnFailure,
    });
  }
  const after =
    before.inspection.status === "passed"
      ? await inspectRepository({
          git: context.git,
          baselineCommit: context.session.baselineCommit,
          policySourceCommit: context.session.policySourceCommit,
          trustedPolicyHash: context.session.trustedPolicyHash,
          config: context.config,
          mode: "local",
        })
      : before;
  const stateChanged =
    before.inspection.repositoryStateFingerprint !==
    after.inspection.repositoryStateFingerprint;
  const failureKind =
    before.inspection.status === "blocked"
      ? "policy"
      : commands.some((command) => command.status !== "passed")
        ? "command"
        : stateChanged
          ? "state-changed"
          : undefined;
  const payload = buildPayload({
    mode: "local",
    sessionId: context.session.sessionId,
    task: context.session.task,
    repositoryId: context.session.repositoryId,
    baselineCommit: context.session.baselineCommit,
    policySourceCommit: context.session.policySourceCommit,
    trustedPolicyHash: context.session.trustedPolicyHash,
    inspection: after.inspection,
    commands,
    startedAt,
    ...(stateChanged
      ? { failureReason: "Repository state changed during verification." }
      : {}),
  });
  const stored = await writeReceipt({
    root: context.git.root,
    config: context.config,
    payload,
    attempt: failureKind !== undefined,
  });
  if (!failureKind) {
    await writeActiveReceiptPointer(context.git.root, {
      schemaVersion: 1,
      sessionId: context.session.sessionId,
      path: stored.relativePath,
      receiptDigest: stored.receipt.digest.value,
    });
  }
  const inspectionOnly = payload.finalStatus === "inspection_only";
  const completionAuthorized =
    !failureKind &&
    (!inspectionOnly ||
      context.config.validation.allowInspectionOnlyCompletion);
  return {
    passed: failureKind === undefined,
    evidenceValid: failureKind === undefined,
    inspectionOnly,
    completionAuthorized,
    receiptPath: stored.relativePath,
    receipt: stored.receipt,
    ...(failureKind === undefined ? {} : { failureKind }),
  };
}

export async function verifyCi(
  cwd: string,
  baseRef: string,
): Promise<VerificationRunResult> {
  const startedAt = new Date().toISOString();
  const git = await GitClient.discover(cwd);
  const policySourceCommit = await git.resolveCommit(baseRef);
  const currentHead = await git.head();
  const baselineCommit = await git.mergeBase(currentHead, policySourceCommit);
  const policyBytes = await git.showFile(policySourceCommit, "judgelock.yml");
  if (!policyBytes)
    throw new JudgeLockError(
      `Trusted base ref '${baseRef}' does not contain judgelock.yml.`,
      {
        code: "TRUSTED_BASE_POLICY_MISSING",
        exitCode: ExitCode.PRECONDITION_FAILED,
        remediation:
          "Land judgelock.yml on the trusted base branch before enabling JudgeLock CI.",
      },
    );
  const config = parseConfig(
    policyBytes.toString("utf8"),
    `${policySourceCommit}:judgelock.yml`,
  );
  const trustedPolicyHash = sha256(policyBytes);
  const before = await inspectRepository({
    git,
    baselineCommit,
    policySourceCommit,
    trustedPolicyHash,
    config,
    mode: "ci",
  });
  const commands =
    before.inspection.status === "passed"
      ? await executeCommands({
          config,
          root: git.root,
          continueOnFailure: false,
        })
      : [];
  const after =
    before.inspection.status === "passed"
      ? await inspectRepository({
          git,
          baselineCommit,
          policySourceCommit,
          trustedPolicyHash,
          config,
          mode: "ci",
        })
      : before;
  const stateChanged =
    before.inspection.repositoryStateFingerprint !==
    after.inspection.repositoryStateFingerprint;
  const executionFailureKind =
    before.inspection.status === "blocked"
      ? "policy"
      : commands.some((command) => command.status !== "passed")
        ? "command"
        : stateChanged
          ? "state-changed"
          : undefined;
  const payload = buildPayload({
    mode: "ci",
    repositoryId: await repositoryIdentifier(git, baselineCommit),
    baselineCommit,
    policySourceCommit,
    trustedPolicyHash,
    inspection: after.inspection,
    commands,
    startedAt,
    ...(stateChanged
      ? { failureReason: "Repository state changed during verification." }
      : {}),
  });
  const stored = await writeReceipt({ root: git.root, config, payload });
  const inspectionOnly = payload.finalStatus === "inspection_only";
  const evidenceValid = executionFailureKind === undefined;
  const completionAuthorized =
    evidenceValid &&
    (!inspectionOnly || config.validation.allowInspectionOnlyCompletion);
  const failureKind =
    executionFailureKind ??
    (inspectionOnly && !completionAuthorized ? "inspection-only" : undefined);
  return {
    passed: completionAuthorized,
    evidenceValid,
    inspectionOnly,
    completionAuthorized,
    receiptPath: stored.relativePath,
    receipt: stored.receipt,
    ...(failureKind === undefined ? {} : { failureKind }),
  };
}
