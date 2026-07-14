import { GitClient } from "../git/client";
import { loadReceipt } from "../receipts/store";
import { validateActiveReceipt } from "../receipts/validate";
import {
  loadSession,
  loadTrustedSessionContext,
  readActiveReceiptPointer,
} from "../state/session";

export interface StatusResult {
  active: boolean;
  task?: string;
  baselineCommit?: string;
  inspection?: "passed" | "blocked";
  validReceipt?: boolean;
  evidenceValid?: boolean;
  inspectionOnly?: boolean;
  completionAuthorized?: boolean;
  receiptMatchesCurrentTree?: boolean;
  receiptPath?: string;
  requiredChecks?: { name: string; passed: boolean }[];
  warning?: string;
  nextAction: string;
}

export async function getStatus(cwd: string): Promise<StatusResult> {
  const git = await GitClient.discover(cwd);
  const session = await loadSession(git.root, true);
  if (!session)
    return {
      active: false,
      nextAction:
        "Run 'judgelock start --task \"...\"' from a clean committed baseline.",
    };
  const context = await loadTrustedSessionContext(cwd);
  const validation = await validateActiveReceipt(cwd);
  const pointer = await readActiveReceiptPointer(git.root);
  const receipt = pointer ? await loadReceipt(git.root, pointer.path) : null;
  const checks = context.config.validation.commands.map((command, index) => {
    const result = receipt?.payload.commands[index];
    return {
      name: command.name,
      passed: result?.name === command.name && result.status === "passed",
    };
  });
  const currentFingerprint = validation.inspection?.repositoryStateFingerprint;
  const receiptMatchesCurrentTree =
    currentFingerprint !== undefined &&
    receipt?.payload.repositoryStateFingerprint === currentFingerprint;
  return {
    active: true,
    task: session.task,
    baselineCommit: session.baselineCommit,
    ...(validation.inspection === undefined
      ? {}
      : { inspection: validation.inspection.status }),
    validReceipt: validation.valid,
    evidenceValid: validation.evidenceValid,
    inspectionOnly: validation.inspectionOnly,
    completionAuthorized: validation.completionAuthorized,
    receiptMatchesCurrentTree,
    ...(validation.receiptPath === undefined
      ? {}
      : { receiptPath: validation.receiptPath }),
    requiredChecks: checks,
    ...(checks.length === 0
      ? {
          warning:
            "NO_VALIDATION_COMMANDS: JudgeLock performed inspection only. No tests, lint checks, type checks, or builds were run.",
        }
      : {}),
    nextAction: validation.completionAuthorized
      ? "Completion may be claimed; include the receipt path in the report."
      : validation.reason,
  };
}
