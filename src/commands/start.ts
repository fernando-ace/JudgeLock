import { CONFIG_FILE, ExitCode } from "../constants";
import { parseConfig } from "../config/load";
import { JudgeLockError } from "../errors";
import { GitClient } from "../git/client";
import { createSession } from "../state/session";
import type { SessionPayloadV1 } from "../types";
import { isSnapshotPath, isTestPath } from "../util/paths";

export interface StartResult {
  session: SessionPayloadV1;
  protectedTests: number;
  protectedSnapshots: number;
}

export async function startSession(
  cwd: string,
  task: string,
): Promise<StartResult> {
  if (task.trim().length === 0) {
    throw new JudgeLockError("A non-empty task description is required.", {
      code: "TASK_REQUIRED",
      exitCode: ExitCode.INVALID_INPUT_OR_CONFIG,
    });
  }
  const git = await GitClient.discover(cwd);
  const baselineCommit = await git.head();
  const status = await git.isClean();
  if (!status.clean) {
    throw new JudgeLockError(
      "JudgeLock will not start from a dirty working tree.",
      {
        code: "DIRTY_WORKING_TREE",
        exitCode: ExitCode.PRECONDITION_FAILED,
        remediation:
          "Commit, stash, or remove every staged, unstaged, and untracked change, then retry.",
      },
    );
  }
  const policyBytes = await git.showFile(baselineCommit, CONFIG_FILE);
  if (!policyBytes) {
    throw new JudgeLockError(`${CONFIG_FILE} is not committed at HEAD.`, {
      code: "COMMITTED_POLICY_REQUIRED",
      exitCode: ExitCode.PRECONDITION_FAILED,
      remediation:
        "Run 'judgelock init', review the policy, and commit it before starting.",
    });
  }
  const config = parseConfig(
    policyBytes.toString("utf8"),
    `${baselineCommit}:${CONFIG_FILE}`,
  );
  const tree = await git.listTree(baselineCommit);
  const files = [...tree.keys()];
  const session = await createSession({
    git,
    task,
    baselineCommit,
    policyBytes,
  });
  return {
    session,
    protectedTests: files.filter((path) => isTestPath(path, config)).length,
    protectedSnapshots: files.filter((path) => isSnapshotPath(path, config))
      .length,
  };
}
