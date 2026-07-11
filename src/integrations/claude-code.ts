import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ExitCode } from "../constants";
import { JudgeLockError } from "../errors";
import { GitClient } from "../git/client";
import { atomicWriteFile } from "../util/atomic";
import { sha256 } from "../util/hash";

const SETTINGS_RELATIVE_PATH = ".claude/settings.json";
const LAUNCHER_RELATIVE_PATH = ".claude/hooks/judgelock.cjs";
const OWNERSHIP_RELATIVE_PATH = ".judgelock/integrations/claude-code.json";
const BACKUP_RELATIVE_DIRECTORY = ".judgelock/backups/claude-code";
const LAUNCHER_ARGUMENT = "${CLAUDE_PROJECT_DIR}/.claude/hooks/judgelock.cjs";

type JsonObject = Record<string, unknown>;

interface ClaudeCodeOwnershipV1 {
  schemaVersion: 1;
  integration: "claude-code";
  settingsPath: typeof SETTINGS_RELATIVE_PATH;
  launcherPath: typeof LAUNCHER_RELATIVE_PATH;
  launcherSha256: string;
  settingsCreatedByJudgeLock: boolean;
}

export interface ClaudeCodeIntegrationResult {
  schemaVersion: 1;
  integration: "claude-code";
  action: "installed" | "uninstalled";
  root: string;
  settingsPath: string;
  launcherPath: string;
  changed: boolean;
  backupPath?: string;
  launcherSha256?: string;
}

interface FileSnapshot {
  path: string;
  bytes: Buffer | null;
}

const CLAUDE_HOOK_LAUNCHER = `#!/usr/bin/env node
"use strict";

// Generated and owned by JudgeLock. Reinstall the integration instead of editing this file.
const { existsSync } = require("node:fs");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, isAbsolute, join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const MAX_DIAGNOSTIC_CHARACTERS = 8000;

function deny(message) {
  const text = String(message || "JudgeLock denied the hook request.");
  process.stderr.write(text.slice(0, MAX_DIAGNOSTIC_CHARACTERS) + "\\n");
  process.exit(2);
}

function parseInput() {
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch (error) {
    deny("JudgeLock could not read Claude Code hook input: " + error.message);
  }

  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      deny("JudgeLock received a non-object Claude Code hook payload.");
    }
    return value;
  } catch (error) {
    deny("JudgeLock received malformed Claude Code hook JSON: " + error.message);
  }
}

function resolveCli(projectRoot) {
  const override = process.env.JUDGELOCK_CLI_PATH;
  if (override) {
    const candidate = isAbsolute(override) ? override : resolve(projectRoot, override);
    if (!existsSync(candidate)) deny("JUDGELOCK_CLI_PATH does not identify an existing file.");
    return candidate;
  }

  try {
    const requireFromProject = createRequire(join(projectRoot, "package.json"));
    const packageJson = requireFromProject.resolve("judgelock/package.json");
    const candidate = join(dirname(packageJson), "dist", "cli.js");
    if (existsSync(candidate)) return candidate;
  } catch {
    // Fall through to the conventional local dependency path for a clearer error.
  }

  const localCandidate = join(projectRoot, "node_modules", "judgelock", "dist", "cli.js");
  if (existsSync(localCandidate)) return localCandidate;
  deny("JudgeLock is not installed in this project. Install judgelock as an exact dev dependency.");
}

const input = parseInput();
const action = process.argv[2];
const projectRoot = resolve(
  process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" ? input.cwd : process.cwd()),
);
const cliPath = resolveCli(projectRoot);
let args;

if (action === "can-write") {
  if (input.tool_name !== "Edit" && input.tool_name !== "Write") {
    deny("JudgeLock can-write received an unexpected Claude Code tool name.");
  }
  const filePath = input.tool_input && input.tool_input.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) {
    deny("JudgeLock can-write requires tool_input.file_path.");
  }
  args = ["hook", "can-write", "--path", filePath, "--json"];
} else if (action === "can-stop") {
  args = ["hook", "can-stop", "--json"];
} else {
  deny("JudgeLock hook launcher received an unknown action.");
}

const result = spawnSync(process.execPath, [cliPath, ...args], {
  cwd: projectRoot,
  encoding: "utf8",
  windowsHide: true,
});

if (result.error) deny("JudgeLock hook execution failed: " + result.error.message);
if (result.status !== 0) {
  const diagnostic = (result.stderr || result.stdout || "JudgeLock denied the operation.").trim();
  deny(diagnostic);
}
process.exit(0);
`;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string, code: string, cause?: unknown): never {
  throw new JudgeLockError(message, {
    code,
    exitCode: ExitCode.INTEGRATION_FAILED,
    remediation:
      "Restore the most recent .judgelock/backups/claude-code snapshot if needed, then retry.",
    cause,
  });
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

function parseSettings(bytes: Buffer | null): JsonObject {
  if (bytes === null) return {};
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isObject(parsed))
      fail(
        ".claude/settings.json must contain a JSON object.",
        "CLAUDE_CODE_SETTINGS_INVALID",
      );
    return parsed;
  } catch (error) {
    if (error instanceof JudgeLockError) throw error;
    fail(
      "Could not parse .claude/settings.json as JSON.",
      "CLAUDE_CODE_SETTINGS_INVALID",
      error,
    );
  }
}

function isOwnedHandler(value: unknown): boolean {
  if (
    !isObject(value) ||
    value.type !== "command" ||
    !Array.isArray(value.args)
  )
    return false;
  return (
    value.args[0] === LAUNCHER_ARGUMENT &&
    (value.args[1] === "can-write" || value.args[1] === "can-stop")
  );
}

function stripOwnedHandlers(value: unknown, eventName: string): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(
      `Claude Code hooks.${eventName} must be an array.`,
      "CLAUDE_CODE_SETTINGS_INVALID",
    );
  }

  return value.flatMap((group): JsonObject[] => {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      fail(
        `Each Claude Code hooks.${eventName} entry must contain a hooks array.`,
        "CLAUDE_CODE_SETTINGS_INVALID",
      );
    }
    const handlers = group.hooks.filter((handler) => !isOwnedHandler(handler));
    return handlers.length === 0 ? [] : [{ ...group, hooks: handlers }];
  });
}

function hooksObject(settings: JsonObject): JsonObject {
  if (settings.hooks === undefined) return {};
  if (!isObject(settings.hooks))
    fail(
      "Claude Code settings.hooks must be an object.",
      "CLAUDE_CODE_SETTINGS_INVALID",
    );
  return { ...settings.hooks };
}

function withInstalledHooks(settings: JsonObject): JsonObject {
  const next = structuredClone(settings);
  const hooks = hooksObject(next);
  const preToolUse = stripOwnedHandlers(hooks.PreToolUse, "PreToolUse");
  const stop = stripOwnedHandlers(hooks.Stop, "Stop");

  preToolUse.push({
    matcher: "Edit|Write",
    hooks: [
      {
        type: "command",
        command: "node",
        args: [LAUNCHER_ARGUMENT, "can-write"],
      },
    ],
  });
  stop.push({
    hooks: [
      {
        type: "command",
        command: "node",
        args: [LAUNCHER_ARGUMENT, "can-stop"],
      },
    ],
  });

  hooks.PreToolUse = preToolUse;
  hooks.Stop = stop;
  next.hooks = hooks;
  return next;
}

function withoutInstalledHooks(settings: JsonObject): JsonObject {
  const next = structuredClone(settings);
  if (next.hooks === undefined) return next;
  const hooks = hooksObject(next);
  const preToolUse = stripOwnedHandlers(hooks.PreToolUse, "PreToolUse");
  const stop = stripOwnedHandlers(hooks.Stop, "Stop");

  if (preToolUse.length > 0) hooks.PreToolUse = preToolUse;
  else delete hooks.PreToolUse;
  if (stop.length > 0) hooks.Stop = stop;
  else delete hooks.Stop;

  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

function settingsEqual(left: JsonObject, right: JsonObject): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function serializedJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseOwnership(bytes: Buffer | null): ClaudeCodeOwnershipV1 | null {
  if (bytes === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(
      "Claude Code integration ownership state is corrupt.",
      "CLAUDE_CODE_OWNERSHIP_CORRUPT",
      error,
    );
  }
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.integration !== "claude-code" ||
    value.settingsPath !== SETTINGS_RELATIVE_PATH ||
    value.launcherPath !== LAUNCHER_RELATIVE_PATH ||
    typeof value.launcherSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.launcherSha256) ||
    typeof value.settingsCreatedByJudgeLock !== "boolean"
  ) {
    fail(
      "Claude Code integration ownership state is invalid.",
      "CLAUDE_CODE_OWNERSHIP_CORRUPT",
    );
  }
  return value as unknown as ClaudeCodeOwnershipV1;
}

async function createBackup(
  root: string,
  operation: "install" | "uninstall",
  files: FileSnapshot[],
): Promise<string> {
  const suffix = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const backupRoot = join(root, BACKUP_RELATIVE_DIRECTORY, suffix);
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const manifest: JsonObject = {
    schemaVersion: 1,
    integration: "claude-code",
    operation,
    createdAt: new Date().toISOString(),
    files: files.map((file) => ({
      path: file.path,
      existed: file.bytes !== null,
      ...(file.bytes === null
        ? {}
        : { byteCount: file.bytes.byteLength, sha256: sha256(file.bytes) }),
    })),
  };

  for (const file of files) {
    if (file.bytes !== null)
      await atomicWriteFile(join(backupRoot, file.path), file.bytes);
  }
  await atomicWriteFile(
    join(backupRoot, "manifest.json"),
    serializedJson(manifest),
  );
  return backupRoot;
}

async function writeSharedFile(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  await atomicWriteFile(path, contents);
  await chmod(path, mode);
}

function resultBase(
  root: string,
): Omit<ClaudeCodeIntegrationResult, "action" | "changed"> {
  return {
    schemaVersion: 1,
    integration: "claude-code",
    root,
    settingsPath: join(root, SETTINGS_RELATIVE_PATH),
    launcherPath: join(root, LAUNCHER_RELATIVE_PATH),
  };
}

export async function installClaudeCode(
  cwd: string,
): Promise<ClaudeCodeIntegrationResult> {
  try {
    const git = await GitClient.discover(cwd);
    const root = git.root;
    const settingsPath = join(root, SETTINGS_RELATIVE_PATH);
    const launcherPath = join(root, LAUNCHER_RELATIVE_PATH);
    const ownershipPath = join(root, OWNERSHIP_RELATIVE_PATH);
    const [settingsBytes, launcherBytes, ownershipBytes] = await Promise.all([
      readOptional(settingsPath),
      readOptional(launcherPath),
      readOptional(ownershipPath),
    ]);
    const settings = parseSettings(settingsBytes);
    const ownership = parseOwnership(ownershipBytes);
    const expectedLauncherBytes = Buffer.from(CLAUDE_HOOK_LAUNCHER, "utf8");
    const expectedLauncherHash = sha256(expectedLauncherBytes);

    if (launcherBytes !== null) {
      const currentHash = sha256(launcherBytes);
      if (ownership === null && currentHash !== expectedLauncherHash) {
        fail(
          ".claude/hooks/judgelock.cjs already exists and is not owned by this JudgeLock integration.",
          "CLAUDE_CODE_LAUNCHER_CONFLICT",
        );
      }
      if (
        ownership !== null &&
        currentHash !== ownership.launcherSha256 &&
        currentHash !== expectedLauncherHash
      ) {
        fail(
          ".claude/hooks/judgelock.cjs changed after JudgeLock installed it; refusing to overwrite it.",
          "CLAUDE_CODE_LAUNCHER_MODIFIED",
        );
      }
    }

    const nextSettings = withInstalledHooks(settings);
    const settingsChanged = !settingsEqual(settings, nextSettings);
    const launcherChanged = !launcherBytes?.equals(expectedLauncherBytes);
    let backupPath: string | undefined;
    if (settingsChanged || launcherChanged) {
      backupPath = await createBackup(root, "install", [
        { path: SETTINGS_RELATIVE_PATH, bytes: settingsBytes },
        { path: LAUNCHER_RELATIVE_PATH, bytes: launcherBytes },
      ]);
    }

    if (settingsChanged)
      await writeSharedFile(settingsPath, serializedJson(nextSettings), 0o644);
    if (launcherChanged)
      await writeSharedFile(launcherPath, CLAUDE_HOOK_LAUNCHER, 0o755);

    const nextOwnership: ClaudeCodeOwnershipV1 = {
      schemaVersion: 1,
      integration: "claude-code",
      settingsPath: SETTINGS_RELATIVE_PATH,
      launcherPath: LAUNCHER_RELATIVE_PATH,
      launcherSha256: expectedLauncherHash,
      settingsCreatedByJudgeLock:
        ownership?.settingsCreatedByJudgeLock ?? settingsBytes === null,
    };
    const nextOwnershipText = serializedJson(nextOwnership);
    const ownershipChanged =
      ownershipBytes?.toString("utf8") !== nextOwnershipText;
    if (ownershipChanged)
      await atomicWriteFile(ownershipPath, nextOwnershipText);

    return {
      ...resultBase(root),
      action: "installed",
      changed: settingsChanged || launcherChanged || ownershipChanged,
      ...(backupPath === undefined ? {} : { backupPath }),
      launcherSha256: expectedLauncherHash,
    };
  } catch (error) {
    if (
      error instanceof JudgeLockError &&
      error.exitCode === ExitCode.INTEGRATION_FAILED
    )
      throw error;
    throw new JudgeLockError(
      `Could not install the Claude Code integration: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: "CLAUDE_CODE_INSTALL_FAILED",
        exitCode: ExitCode.INTEGRATION_FAILED,
        remediation:
          "Run this command inside the target Git repository and verify .claude and .judgelock are writable.",
        cause: error,
      },
    );
  }
}

export async function uninstallClaudeCode(
  cwd: string,
): Promise<ClaudeCodeIntegrationResult> {
  try {
    const git = await GitClient.discover(cwd);
    const root = git.root;
    const settingsPath = join(root, SETTINGS_RELATIVE_PATH);
    const launcherPath = join(root, LAUNCHER_RELATIVE_PATH);
    const ownershipPath = join(root, OWNERSHIP_RELATIVE_PATH);
    const [settingsBytes, launcherBytes, ownershipBytes] = await Promise.all([
      readOptional(settingsPath),
      readOptional(launcherPath),
      readOptional(ownershipPath),
    ]);
    const settings = parseSettings(settingsBytes);
    const ownership = parseOwnership(ownershipBytes);
    const expectedLauncherBytes = Buffer.from(CLAUDE_HOOK_LAUNCHER, "utf8");
    const expectedLauncherHash = sha256(expectedLauncherBytes);

    if (launcherBytes !== null) {
      const currentHash = sha256(launcherBytes);
      if (ownership !== null && currentHash !== ownership.launcherSha256) {
        fail(
          ".claude/hooks/judgelock.cjs changed after JudgeLock installed it; refusing to delete it.",
          "CLAUDE_CODE_LAUNCHER_MODIFIED",
        );
      }
      if (ownership === null && currentHash !== expectedLauncherHash) {
        fail(
          ".claude/hooks/judgelock.cjs is not owned by this JudgeLock integration.",
          "CLAUDE_CODE_LAUNCHER_CONFLICT",
        );
      }
    }

    const nextSettings = withoutInstalledHooks(settings);
    const settingsChanged = !settingsEqual(settings, nextSettings);
    const launcherOwned =
      launcherBytes !== null &&
      (ownership !== null || sha256(launcherBytes) === expectedLauncherHash);
    const ownershipChanged = ownershipBytes !== null;
    let backupPath: string | undefined;
    if (settingsChanged || launcherOwned) {
      backupPath = await createBackup(root, "uninstall", [
        { path: SETTINGS_RELATIVE_PATH, bytes: settingsBytes },
        { path: LAUNCHER_RELATIVE_PATH, bytes: launcherBytes },
      ]);
    }

    if (settingsChanged) {
      const removeCreatedSettings =
        ownership?.settingsCreatedByJudgeLock === true &&
        Object.keys(nextSettings).length === 0;
      if (removeCreatedSettings) await rm(settingsPath, { force: true });
      else
        await writeSharedFile(
          settingsPath,
          serializedJson(nextSettings),
          0o644,
        );
    }
    if (launcherOwned) await rm(launcherPath, { force: true });
    if (ownershipChanged) await rm(ownershipPath, { force: true });

    const hooksDirectory = dirname(launcherPath);
    try {
      await rmdir(hooksDirectory);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOTEMPTY" ||
          error.code === "EEXIST" ||
          error.code === "ENOENT")
      ))
        throw error;
    }

    return {
      ...resultBase(root),
      action: "uninstalled",
      changed: settingsChanged || launcherOwned || ownershipChanged,
      ...(backupPath === undefined ? {} : { backupPath }),
    };
  } catch (error) {
    if (
      error instanceof JudgeLockError &&
      error.exitCode === ExitCode.INTEGRATION_FAILED
    )
      throw error;
    throw new JudgeLockError(
      `Could not uninstall the Claude Code integration: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: "CLAUDE_CODE_UNINSTALL_FAILED",
        exitCode: ExitCode.INTEGRATION_FAILED,
        remediation: "Verify .claude and .judgelock are writable, then retry.",
        cause: error,
      },
    );
  }
}

export const claudeCodeIntegrationPaths = {
  settings: SETTINGS_RELATIVE_PATH,
  launcher: LAUNCHER_RELATIVE_PATH,
  ownership: OWNERSHIP_RELATIVE_PATH,
} as const;
