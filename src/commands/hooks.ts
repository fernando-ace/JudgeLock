import { ExitCode } from "../constants";
import { GitClient } from "../git/client";
import { validateActiveReceipt } from "../receipts/validate";
import { loadSession, loadTrustedSessionContext } from "../state/session";
import type { HookStopDecision, HookWriteDecision } from "../types";
import { isProtectedPath, isSnapshotPath, isTestPath } from "../util/paths";
import { resolveSafeRepositoryPath } from "../util/safe-path";

function deny(
  path: string,
  reasonCode: string,
  explanation: string,
): HookWriteDecision {
  return { schemaVersion: 1, decision: "deny", reasonCode, path, explanation };
}

export async function canWrite(
  cwd: string,
  suppliedPath: string,
): Promise<{ decision: HookWriteDecision; exitCode: number }> {
  const git = await GitClient.discover(cwd);
  const session = await loadSession(git.root, true);
  if (!session) {
    return {
      decision: {
        schemaVersion: 1,
        decision: "allow",
        reasonCode: "NO_ACTIVE_SESSION",
        path: suppliedPath,
        explanation: "No JudgeLock session is active.",
      },
      exitCode: ExitCode.OK,
    };
  }
  const context = await loadTrustedSessionContext(cwd);
  let resolved: Awaited<ReturnType<typeof resolveSafeRepositoryPath>>;
  try {
    resolved = await resolveSafeRepositoryPath(git.root, suppliedPath);
  } catch (error) {
    return {
      decision: deny(
        suppliedPath,
        "PATH_OUTSIDE_REPOSITORY",
        error instanceof Error ? error.message : String(error),
      ),
      exitCode: ExitCode.POLICY_VIOLATION,
    };
  }
  const path = resolved.relative;
  const tree = await git.listTree(session.baselineCommit);
  if (
    path === "judgelock.yml" ||
    path === ".claude/settings.json" ||
    path === ".claude/hooks/judgelock.cjs" ||
    path === ".judgelock" ||
    path.startsWith(".judgelock/")
  ) {
    return {
      decision: deny(
        path,
        "JUDGE_CONFIGURATION_PROTECTED",
        "JudgeLock policy, state, and installed enforcement files cannot be edited during a session.",
      ),
      exitCode: ExitCode.POLICY_VIOLATION,
    };
  }
  if (isProtectedPath(path, context.config)) {
    return {
      decision: deny(
        path,
        "PROTECTED_PATH_CHANGED",
        "The trusted policy marks this path as protected.",
      ),
      exitCode: ExitCode.POLICY_VIOLATION,
    };
  }
  if (
    isSnapshotPath(path, context.config) &&
    context.config.testIntegrity.blockSnapshotChanges
  ) {
    return {
      decision: deny(
        path,
        "SNAPSHOT_CHANGED",
        "Snapshot changes are blocked by the trusted policy.",
      ),
      exitCode: ExitCode.POLICY_VIOLATION,
    };
  }
  if (isTestPath(path, context.config)) {
    const existed = tree.has(path);
    if (existed && context.config.testIntegrity.existingTests === "immutable") {
      return {
        decision: deny(
          path,
          "EXISTING_TEST_MODIFIED",
          "This test existed at the session baseline and is immutable.",
        ),
        exitCode: ExitCode.POLICY_VIOLATION,
      };
    }
    if (!existed && !context.config.testIntegrity.allowNewTests) {
      return {
        decision: deny(
          path,
          "NEW_TEST_NOT_ALLOWED",
          "The trusted policy does not allow new test files.",
        ),
        exitCode: ExitCode.POLICY_VIOLATION,
      };
    }
  }
  return {
    decision: {
      schemaVersion: 1,
      decision: "allow",
      reasonCode: "WRITE_ALLOWED",
      path,
      explanation:
        "This path is not blocked by the early path guard. Inspect remains authoritative.",
    },
    exitCode: ExitCode.OK,
  };
}

export async function canStop(
  cwd: string,
): Promise<{ decision: HookStopDecision; exitCode: number }> {
  const validation = await validateActiveReceipt(cwd);
  if (!validation.valid) {
    return {
      decision: {
        schemaVersion: 1,
        decision: "deny",
        reasonCode: "COMPLETION_BLOCKED",
        explanation: validation.reason,
      },
      exitCode: ExitCode.COMPLETION_BLOCKED,
    };
  }
  return {
    decision: {
      schemaVersion: 1,
      decision: "allow",
      reasonCode: "COMPLETION_ALLOWED",
      explanation: validation.reason,
      ...(validation.receiptPath === undefined
        ? {}
        : { receiptPath: validation.receiptPath }),
    },
    exitCode: ExitCode.OK,
  };
}
