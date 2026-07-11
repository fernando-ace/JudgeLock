import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, ExitCode } from "../constants";
import { DEFAULT_CONFIG } from "../config/defaults";
import { JudgeLockError } from "../errors";
import { GitClient } from "../git/client";
import { atomicWriteFile } from "../util/atomic";

export interface InitResult {
  root: string;
  created: string[];
  updated: string[];
  unchanged: string[];
}

async function findRoot(cwd: string): Promise<string> {
  try {
    return (await GitClient.discover(cwd)).root;
  } catch {
    return cwd;
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return null;
    throw error;
  }
}

function ignoresJudgeLock(contents: string): boolean {
  return contents
    .split(/\r?\n/u)
    .some((line) =>
      [".judgelock", ".judgelock/", "/.judgelock", "/.judgelock/"].includes(
        line.trim(),
      ),
    );
}

export async function initializePolicy(
  cwd: string,
  force: boolean,
): Promise<InitResult> {
  const root = await findRoot(cwd);
  const configPath = join(root, CONFIG_FILE);
  const ignorePath = join(root, ".gitignore");
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const existingConfig = await readOptional(configPath);
  if (existingConfig !== null && !force) {
    throw new JudgeLockError(`${CONFIG_FILE} already exists.`, {
      code: "CONFIG_EXISTS",
      exitCode: ExitCode.INVALID_INPUT_OR_CONFIG,
      remediation: "Review the existing policy or pass --force to replace it.",
    });
  }
  await atomicWriteFile(configPath, DEFAULT_CONFIG);
  (existingConfig === null ? created : updated).push(CONFIG_FILE);

  const existingIgnore = await readOptional(ignorePath);
  if (existingIgnore === null) {
    await atomicWriteFile(ignorePath, "/.judgelock/\n");
    created.push(".gitignore");
  } else if (ignoresJudgeLock(existingIgnore)) {
    unchanged.push(".gitignore");
  } else {
    const newline = existingIgnore.includes("\r\n") ? "\r\n" : "\n";
    const separator =
      existingIgnore.length === 0 || existingIgnore.endsWith("\n")
        ? ""
        : newline;
    await atomicWriteFile(
      ignorePath,
      `${existingIgnore}${separator}/.judgelock/${newline}`,
    );
    updated.push(".gitignore");
  }
  return { root, created, updated, unchanged };
}
