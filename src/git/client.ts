import { execa } from "execa";
import { ExitCode } from "../constants";
import { JudgeLockError } from "../errors";
import type { ChangeKind, ChangedFile, GitTreeEntry } from "../types";
import { normalizeRepoPath } from "../util/paths";

interface GitResult<T extends string | Buffer> {
  stdout: T;
  stderr: T;
  exitCode: number;
}

export interface DiffRecord {
  kind: ChangeKind;
  path: string;
  oldPath?: string;
}

function toChangeKind(status: string): ChangeKind {
  switch (status[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "T":
      return "type-changed";
    default:
      return "modified";
  }
}

export function parseNameStatusZ(output: string): DiffRecord[] {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const records: DiffRecord[] = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index++];
    const firstPath = tokens[index++];
    if (!status || firstPath === undefined)
      throw new Error("Unexpected Git name-status output.");
    if (status.startsWith("R") || status.startsWith("C")) {
      const newPath = tokens[index++];
      if (newPath === undefined)
        throw new Error("Git rename record is missing its destination.");
      records.push({
        kind: "renamed",
        oldPath: normalizeRepoPath(firstPath),
        path: normalizeRepoPath(newPath),
      });
    } else {
      records.push({
        kind: toChangeKind(status),
        path: normalizeRepoPath(firstPath),
      });
    }
  }
  return records;
}

export class GitClient {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  static async discover(cwd: string): Promise<GitClient> {
    const result = await execa("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      reject: false,
    });
    if (result.exitCode !== 0) {
      throw new JudgeLockError("JudgeLock requires a Git repository.", {
        code: "GIT_REPOSITORY_REQUIRED",
        exitCode: ExitCode.PRECONDITION_FAILED,
        remediation: "Run the command inside a Git repository.",
      });
    }
    return new GitClient(result.stdout.trim());
  }

  async run(args: string[]): Promise<GitResult<string>> {
    const result = await execa("git", args, {
      cwd: this.root,
      reject: false,
      stripFinalNewline: false,
      env: { GIT_OPTIONAL_LOCKS: "0" },
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 1,
    };
  }

  async runBuffer(args: string[]): Promise<GitResult<Buffer>> {
    const result = await execa("git", args, {
      cwd: this.root,
      reject: false,
      stripFinalNewline: false,
      encoding: "buffer",
      env: { GIT_OPTIONAL_LOCKS: "0" },
    });
    return {
      stdout: Buffer.from(result.stdout),
      stderr: Buffer.from(result.stderr),
      exitCode: result.exitCode ?? 1,
    };
  }

  async requireSuccess(args: string[], message: string): Promise<string> {
    const result = await this.run(args);
    if (result.exitCode !== 0) {
      throw new JudgeLockError(
        `${message}${result.stderr.trim() ? `\n${result.stderr.trim()}` : ""}`,
        {
          code: "GIT_COMMAND_FAILED",
          exitCode: ExitCode.PRECONDITION_FAILED,
        },
      );
    }
    return result.stdout.trim();
  }

  async head(): Promise<string> {
    return this.requireSuccess(
      ["rev-parse", "--verify", "HEAD^{commit}"],
      "The repository has no committed baseline.",
    );
  }

  async resolveCommit(ref: string): Promise<string> {
    if (ref.startsWith("-") || /[\0\r\n]/u.test(ref)) {
      throw new JudgeLockError("The base ref is not safe to pass to Git.", {
        code: "INVALID_BASE_REF",
        exitCode: ExitCode.INVALID_INPUT_OR_CONFIG,
      });
    }
    return this.requireSuccess(
      ["rev-parse", "--verify", `${ref}^{commit}`],
      `Could not resolve base ref '${ref}'.`,
    );
  }

  async mergeBase(left: string, right: string): Promise<string> {
    return this.requireSuccess(
      ["merge-base", left, right],
      "Could not find a merge base. Fetch complete history and retry.",
    );
  }

  async isClean(): Promise<{ clean: boolean; status: string }> {
    const result = await this.run([
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return { clean: result.stdout.length === 0, status: result.stdout };
  }

  async showFile(commit: string, path: string): Promise<Buffer | null> {
    const result = await this.runBuffer([
      "show",
      `${commit}:${normalizeRepoPath(path)}`,
    ]);
    if (result.exitCode !== 0) return null;
    return result.stdout;
  }

  async diffNameStatus(args: string[]): Promise<DiffRecord[]> {
    const result = await this.run([
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      ...args,
      "--",
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return parseNameStatusZ(result.stdout);
  }

  async untrackedFiles(): Promise<string[]> {
    const result = await this.run([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return result.stdout.split("\0").filter(Boolean).map(normalizeRepoPath);
  }

  async listTree(commit: string): Promise<Map<string, GitTreeEntry>> {
    const result = await this.run([
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      commit,
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    const entries = new Map<string, GitTreeEntry>();
    for (const record of result.stdout.split("\0").filter(Boolean)) {
      const tab = record.indexOf("\t");
      const metadata = record.slice(0, tab).split(" ");
      const path = normalizeRepoPath(record.slice(tab + 1));
      const mode = metadata[0];
      const oid = metadata[2];
      if (mode && oid) entries.set(path, { mode, oid });
    }
    return entries;
  }

  async listIndex(): Promise<Map<string, GitTreeEntry[]>> {
    const result = await this.run(["ls-files", "--stage", "-z"]);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    const entries = new Map<string, GitTreeEntry[]>();
    for (const record of result.stdout.split("\0").filter(Boolean)) {
      const tab = record.indexOf("\t");
      const [mode, oid] = record.slice(0, tab).split(" ");
      const path = normalizeRepoPath(record.slice(tab + 1));
      if (!mode || !oid) continue;
      const values = entries.get(path) ?? [];
      values.push({ mode, oid });
      entries.set(path, values);
    }
    return entries;
  }

  async rootCommits(commit: string): Promise<string[]> {
    const output = await this.requireSuccess(
      ["rev-list", "--max-parents=0", commit],
      "Could not identify the repository roots.",
    );
    return output.split(/\r?\n/u).filter(Boolean).sort();
  }
}

export function mergeChangedFiles(
  groups: { records: DiffRecord[]; layer: ChangedFile["layers"][number] }[],
): ChangedFile[] {
  const merged = new Map<string, ChangedFile>();
  for (const group of groups) {
    for (const record of group.records) {
      const key = `${record.oldPath ?? ""}\0${record.path}`;
      const existing = merged.get(key);
      if (existing) {
        if (!existing.layers.includes(group.layer))
          existing.layers.push(group.layer);
        if (existing.kind !== record.kind) existing.kind = record.kind;
      } else {
        merged.set(key, {
          kind: record.kind,
          path: record.path,
          ...(record.oldPath === undefined ? {} : { oldPath: record.oldPath }),
          layers: [group.layer],
        });
      }
    }
  }
  return [...merged.values()].sort((left, right) =>
    left.path === right.path
      ? (left.oldPath ?? "").localeCompare(right.oldPath ?? "")
      : left.path.localeCompare(right.path),
  );
}
