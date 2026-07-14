import { writeFileSync } from "node:fs";
import { Command } from "commander";
import {
  CONFIG_FILE,
  ExitCode,
  JUDGELOCK_VERSION,
  type ExitCodeValue,
} from "../constants";
import { canStop, canWrite } from "../commands/hooks";
import { initializePolicy } from "../commands/init";
import { inspectLocal } from "../commands/inspect";
import { startSession } from "../commands/start";
import { getStatus } from "../commands/status";
import { toJudgeLockError, JudgeLockError } from "../errors";
import { installClaudeCode, uninstallClaudeCode } from "../integrations/index";
import { VIOLATION_REGISTRY } from "../policy/violations";
import { renderInspection, renderVerification } from "../output/render";
import type { CommandEnvelope, FindingCode } from "../types";
import { verifyCi, verifyLocal } from "../verification/verify";

interface ActionResult<T> {
  result: T;
  exitCode: ExitCodeValue;
  human?: string;
  errorCode?: string;
  errorMessage?: string;
}

function writeStdout(value: string): void {
  writeFileSync(process.stdout.fd, value);
}

function successEnvelope<T>(command: string, result: T): CommandEnvelope<T> {
  return { schemaVersion: 1, command, ok: true, exitCode: 0, result };
}

async function runAction<T>(
  command: string,
  json: boolean,
  action: () => Promise<ActionResult<T>> | ActionResult<T>,
): Promise<void> {
  try {
    const outcome = await action();
    process.exitCode = outcome.exitCode;
    if (json) {
      const envelope: CommandEnvelope<T> =
        outcome.exitCode === ExitCode.OK
          ? successEnvelope(command, outcome.result)
          : {
              schemaVersion: 1,
              command,
              ok: false,
              exitCode: outcome.exitCode,
              error: {
                code: outcome.errorCode ?? "COMMAND_BLOCKED",
                message:
                  outcome.errorMessage ??
                  "JudgeLock did not allow this command to pass.",
              },
              result: outcome.result,
            };
      writeStdout(`${JSON.stringify(envelope)}\n`);
    } else if (outcome.human) {
      writeStdout(
        outcome.human.endsWith("\n") ? outcome.human : `${outcome.human}\n`,
      );
    }
  } catch (error) {
    const failure = toJudgeLockError(error);
    process.exitCode = failure.exitCode;
    if (json) {
      const envelope: CommandEnvelope<never> = {
        schemaVersion: 1,
        command,
        ok: false,
        exitCode: failure.exitCode,
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.remediation === undefined
            ? {}
            : { remediation: failure.remediation }),
        },
      };
      writeStdout(`${JSON.stringify(envelope)}\n`);
    } else {
      const remediation = failure.remediation
        ? `\n\n${failure.remediation}`
        : "";
      process.stderr.write(`${failure.message}${remediation}\n`);
    }
  }
}

function currentDirectory(): string {
  return process.cwd();
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("judgelock")
    .description("A test-integrity firewall for agentic coding tools.")
    .version(JUDGELOCK_VERSION);

  program
    .command("init")
    .description(`Create ${CONFIG_FILE} and ignore ephemeral JudgeLock state.`)
    .option("--force", "replace an existing policy")
    .action(async (options: { force?: boolean }) => {
      await runAction("init", false, async () => {
        const result = await initializePolicy(
          currentDirectory(),
          options.force ?? false,
        );
        const lines = [
          ...result.created.map((path) => `Created ${path}`),
          ...result.updated.map((path) => `Updated ${path}`),
          ...result.unchanged.map((path) => `Unchanged ${path}`),
        ];
        return {
          result,
          exitCode: ExitCode.OK,
          human: `${lines.join("\n")}\n`,
        };
      });
    });

  program
    .command("start")
    .description("Start a protected session from a clean committed baseline.")
    .requiredOption("--task <description>", "task being implemented")
    .action(async (options: { task: string }) => {
      await runAction("start", false, async () => {
        const result = await startSession(currentDirectory(), options.task);
        return {
          result,
          exitCode: ExitCode.OK,
          human: `Started JudgeLock session ${result.session.sessionId}\nTask: ${result.session.task}\nBaseline: ${result.session.baselineCommit}\nProtected existing tests: ${String(result.protectedTests)}\nProtected snapshots: ${String(result.protectedSnapshots)}\n`,
        };
      });
    });

  program
    .command("inspect")
    .description("Inspect all repository layers against the active baseline.")
    .option("--json", "emit one machine-readable JSON document")
    .action(async (options: { json?: boolean }) => {
      await runAction("inspect", options.json ?? false, async () => {
        const { inspection } = await inspectLocal(currentDirectory());
        const blocked = inspection.status === "blocked";
        return {
          result: inspection,
          exitCode: blocked ? ExitCode.POLICY_VIOLATION : ExitCode.OK,
          human: renderInspection(inspection),
          ...(blocked
            ? {
                errorCode: "POLICY_VIOLATION",
                errorMessage: "Blocking policy violations were found.",
              }
            : {}),
        };
      });
    });

  program
    .command("verify")
    .description(
      "Inspect, run trusted required commands, and create a state-bound receipt.",
    )
    .option("--json", "emit one machine-readable JSON document")
    .option(
      "--continue-on-failure",
      "run all required commands after a failure",
    )
    .action(
      async (options: { json?: boolean; continueOnFailure?: boolean }) => {
        await runAction("verify", options.json ?? false, async () => {
          const result = await verifyLocal(
            currentDirectory(),
            options.continueOnFailure ?? false,
          );
          const exitCode = result.passed
            ? ExitCode.OK
            : result.failureKind === "policy"
              ? ExitCode.POLICY_VIOLATION
              : ExitCode.VERIFICATION_FAILED;
          return {
            result,
            exitCode,
            human: renderVerification(result.receiptPath, result.receipt),
            ...(result.passed
              ? {}
              : {
                  errorCode: "VERIFICATION_FAILED",
                  errorMessage: "JudgeLock verification did not pass.",
                }),
          };
        });
      },
    );

  program
    .command("status")
    .description("Show session, inspection, and receipt freshness status.")
    .option("--json", "emit one machine-readable JSON document")
    .action(async (options: { json?: boolean }) => {
      await runAction("status", options.json ?? false, async () => {
        const result = await getStatus(currentDirectory());
        const human = result.active
          ? `Session: active\nTask: ${result.task ?? "unknown"}\nBaseline: ${result.baselineCommit ?? "unknown"}\nInspection: ${result.inspection ?? "unavailable"}\nEvidence valid: ${result.evidenceValid === true ? "yes" : "no"}\nInspection only: ${result.inspectionOnly === true ? "yes" : "no"}\nCompletion authorized: ${result.completionAuthorized === true ? "yes" : "no"}\n${result.receiptPath ? `Receipt: ${result.receiptPath}\n` : ""}${result.warning ? `${result.warning}\n` : ""}Next: ${result.nextAction}\n`
          : `Session: inactive\nNext: ${result.nextAction}\n`;
        return { result, exitCode: ExitCode.OK, human };
      });
    });

  program
    .command("explain")
    .description("Explain a stable JudgeLock violation code.")
    .argument("<violation-code>")
    .action(async (rawCode: string) => {
      await runAction("explain", false, () => {
        const normalized = rawCode.toUpperCase();
        if (!Object.hasOwn(VIOLATION_REGISTRY, normalized)) {
          throw new JudgeLockError(`Unknown violation code '${rawCode}'.`, {
            code: "UNKNOWN_VIOLATION_CODE",
            exitCode: ExitCode.INVALID_INPUT_OR_CONFIG,
            remediation: `Known codes: ${Object.keys(VIOLATION_REGISTRY).join(", ")}`,
          });
        }
        const code = normalized as FindingCode;
        const definition = VIOLATION_REGISTRY[code];
        const result = { code, ...definition };
        return {
          result,
          exitCode: ExitCode.OK,
          human: `${code}\n\n${definition.explanation}\n\n${definition.remediation}\n`,
        };
      });
    });

  const hook = program
    .command("hook")
    .description("Stable integration gates for coding-agent hooks.");
  hook
    .command("can-write")
    .description("Decide whether an attempted path write is allowed.")
    .requiredOption("--path <path>", "path the agent intends to write")
    .option("--json", "emit one machine-readable JSON document")
    .action(async (options: { path: string; json?: boolean }) => {
      await runAction("hook can-write", options.json ?? false, async () => {
        const result = await canWrite(currentDirectory(), options.path);
        return {
          result: result.decision,
          exitCode: result.exitCode as ExitCodeValue,
          human: `${result.decision.decision.toUpperCase()}  ${result.decision.reasonCode}\n${result.decision.path}\n\n${result.decision.explanation}\n`,
          ...(result.exitCode === 0
            ? {}
            : {
                errorCode: result.decision.reasonCode,
                errorMessage: result.decision.explanation,
              }),
        };
      });
    });
  hook
    .command("can-stop")
    .description("Allow completion only with a fresh passing receipt.")
    .option("--json", "emit one machine-readable JSON document")
    .action(async (options: { json?: boolean }) => {
      await runAction("hook can-stop", options.json ?? false, async () => {
        const result = await canStop(currentDirectory());
        return {
          result: result.decision,
          exitCode: result.exitCode as ExitCodeValue,
          human: `${result.decision.decision.toUpperCase()}  ${result.decision.reasonCode}\n${result.decision.explanation}${result.decision.receiptPath ? `\nReceipt: ${result.decision.receiptPath}` : ""}\n`,
          ...(result.exitCode === 0
            ? {}
            : {
                errorCode: result.decision.reasonCode,
                errorMessage: result.decision.explanation,
              }),
        };
      });
    });

  program
    .command("ci")
    .description("Enforce trusted base-ref policy without local session state.")
    .requiredOption("--base-ref <ref>", "trusted pull-request base ref")
    .option("--json", "emit one machine-readable JSON document")
    .action(async (options: { baseRef: string; json?: boolean }) => {
      await runAction("ci", options.json ?? false, async () => {
        const result = await verifyCi(currentDirectory(), options.baseRef);
        const exitCode = result.passed
          ? ExitCode.OK
          : result.failureKind === "policy"
            ? ExitCode.POLICY_VIOLATION
            : ExitCode.VERIFICATION_FAILED;
        return {
          result,
          exitCode,
          human: renderVerification(result.receiptPath, result.receipt),
          ...(result.passed
            ? {}
            : {
                errorCode: "CI_ENFORCEMENT_FAILED",
                errorMessage: "JudgeLock CI enforcement did not pass.",
              }),
        };
      });
    });

  program
    .command("install")
    .description("Install an agent integration.")
    .command("claude-code")
    .description("Install project-scoped Claude Code hooks.")
    .option(
      "--autonomous-stop-hook",
      "block every normal Stop event until JudgeLock authorizes completion",
    )
    .action(async (options: { autonomousStopHook?: boolean }) => {
      await runAction("install claude-code", false, async () => {
        const result = await installClaudeCode(currentDirectory(), {
          autonomousStopHook: options.autonomousStopHook ?? false,
        });
        return {
          result,
          exitCode: ExitCode.OK,
          human: `${result.changed ? "Installed" : "Already installed"} Claude Code integration.\nDefault task completion gate: enabled\nAutonomous Stop gate: ${result.autonomousStopHook === true ? "enabled" : "disabled"}\nSettings: ${result.settingsPath}\nLauncher: ${result.launcherPath}${result.backupPath ? `\nBackup: ${result.backupPath}` : ""}\n`,
        };
      });
    });

  program
    .command("uninstall")
    .description("Remove an agent integration.")
    .command("claude-code")
    .description("Remove only JudgeLock-owned Claude Code hooks.")
    .action(async () => {
      await runAction("uninstall claude-code", false, async () => {
        const result = await uninstallClaudeCode(currentDirectory());
        return {
          result,
          exitCode: ExitCode.OK,
          human: `${result.changed ? "Removed" : "No changes needed for"} Claude Code integration.${result.backupPath ? `\nBackup: ${result.backupPath}` : ""}\n`,
        };
      });
    });

  return program;
}

if (process.env.NODE_ENV !== "test") {
  await buildProgram().parseAsync(process.argv);
}
