import { JUDGELOCK_VERSION } from "../constants";
import { inspectRepository } from "../policy/inspect";
import { loadReceipt } from "./store";
import {
  loadTrustedSessionContext,
  readActiveReceiptPointer,
} from "../state/session";
import { sha256 } from "../util/hash";

export interface ActiveReceiptValidation {
  valid: boolean;
  reason: string;
  receiptPath?: string;
  inspection?: Awaited<ReturnType<typeof inspectRepository>>["inspection"];
}

export async function validateActiveReceipt(
  cwd: string,
): Promise<ActiveReceiptValidation> {
  const context = await loadTrustedSessionContext(cwd);
  const inspection = await inspectRepository({
    git: context.git,
    baselineCommit: context.session.baselineCommit,
    policySourceCommit: context.session.policySourceCommit,
    trustedPolicyHash: context.session.trustedPolicyHash,
    config: context.config,
    mode: "local",
  });
  if (inspection.inspection.status === "blocked") {
    return {
      valid: false,
      reason: "Current repository state has blocking policy violations.",
      inspection: inspection.inspection,
    };
  }
  const pointer = await readActiveReceiptPointer(context.git.root);
  if (!pointer)
    return {
      valid: false,
      reason: "No active passing verification receipt exists.",
      inspection: inspection.inspection,
    };
  if (pointer.sessionId !== context.session.sessionId) {
    return {
      valid: false,
      reason: "The active receipt belongs to an older session.",
      inspection: inspection.inspection,
    };
  }
  const receipt = await loadReceipt(context.git.root, pointer.path);
  const payload = receipt.payload;
  const expectedCommands = context.config.validation.commands;
  const commandIdentityMatches =
    payload.commands.length === expectedCommands.length &&
    payload.commands.every((result, index) => {
      const expected = expectedCommands[index];
      return (
        expected?.name === result.name &&
        result.commandHash === sha256(expected.command) &&
        result.timeoutSeconds === expected.timeoutSeconds &&
        result.status === "passed"
      );
    });
  const valid =
    pointer.receiptDigest === receipt.digest.value &&
    payload.finalStatus === "passed" &&
    payload.mode === "local" &&
    payload.sessionId === context.session.sessionId &&
    payload.repositoryId === context.session.repositoryId &&
    payload.baselineCommit === context.session.baselineCommit &&
    payload.policySourceCommit === context.session.policySourceCommit &&
    payload.trustedPolicyHash === context.session.trustedPolicyHash &&
    payload.judgeLockVersion === JUDGELOCK_VERSION &&
    payload.repositoryStateFingerprint ===
      inspection.inspection.repositoryStateFingerprint &&
    commandIdentityMatches;
  return {
    valid,
    reason: valid
      ? "Receipt matches the exact current repository state and all required commands passed."
      : "Receipt is stale or does not match the active session and trusted commands.",
    receiptPath: pointer.path,
    inspection: inspection.inspection,
  };
}
