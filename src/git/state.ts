import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { JudgeLockConfig } from "../config/schema";
import type {
  ChangeLayer,
  FingerprintEntry,
  FingerprintManifestV1,
  RepositoryState,
  WorktreeEntry,
} from "../types";
import { canonicalJson } from "../util/canonical-json";
import { sha256 } from "../util/hash";
import {
  isIgnoredPath,
  isProtectedPath,
  normalizeRepoPath,
} from "../util/paths";
import { mergeChangedFiles, type DiffRecord, type GitClient } from "./client";

function pathIsAlwaysRelevant(path: string): boolean {
  return (
    path === "judgelock.yml" ||
    path === ".claude/settings.json" ||
    path === ".claude/hooks/judgelock.cjs"
  );
}

function relevant(path: string, config: JudgeLockConfig): boolean {
  return (
    pathIsAlwaysRelevant(path) ||
    isProtectedPath(path, config) ||
    !isIgnoredPath(path, config)
  );
}

async function worktreeEntry(
  root: string,
  path: string,
): Promise<{ entry: WorktreeEntry | null; content: Buffer | null }> {
  const absolute = join(root, ...normalizeRepoPath(path).split("/"));
  try {
    const before = await lstat(absolute);
    if (!before.isFile() && !before.isSymbolicLink())
      return { entry: null, content: null };
    const content = before.isSymbolicLink()
      ? Buffer.from(await readlink(absolute))
      : await readFile(absolute);
    const after = await lstat(absolute);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.mode !== after.mode
    ) {
      throw new Error(`Repository state changed while hashing ${path}.`);
    }
    return {
      entry: {
        kind: before.isSymbolicLink() ? "symlink" : "file",
        sha256: sha256(content),
        size: content.byteLength,
        executable: (before.mode & 0o111) !== 0,
      },
      content,
    };
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return { entry: null, content: null };
    throw error;
  }
}

function addPaths(
  target: Set<string>,
  records: DiffRecord[],
  config: JudgeLockConfig,
): void {
  for (const record of records) {
    if (relevant(record.path, config)) target.add(record.path);
    if (record.oldPath && relevant(record.oldPath, config))
      target.add(record.oldPath);
  }
}

function layersFor(
  path: string,
  groups: { layer: ChangeLayer; records: DiffRecord[] }[],
  untracked: Set<string>,
): ChangeLayer[] {
  const layers: ChangeLayer[] = [];
  for (const group of groups) {
    if (
      group.records.some(
        (record) => record.path === path || record.oldPath === path,
      )
    )
      layers.push(group.layer);
  }
  if (untracked.has(path)) layers.push("untracked");
  return layers;
}

export async function captureRepositoryState(options: {
  git: GitClient;
  baselineCommit: string;
  policySourceCommit: string;
  trustedPolicyHash: string;
  config: JudgeLockConfig;
}): Promise<RepositoryState> {
  const { git, baselineCommit, policySourceCommit, trustedPolicyHash, config } =
    options;
  const currentHead = await git.head();
  const committed = await git.diffNameStatus([baselineCommit, currentHead]);
  const staged = await git.diffNameStatus(["--cached", currentHead]);
  const unstaged = await git.diffNameStatus([]);
  const untrackedPaths = (await git.untrackedFiles()).filter((path) =>
    relevant(path, config),
  );
  const untracked = new Set(untrackedPaths);

  const groups = [
    { records: committed, layer: "committed" as const },
    { records: staged, layer: "staged" as const },
    { records: unstaged, layer: "unstaged" as const },
  ];
  const changedFiles = mergeChangedFiles([
    ...groups,
    {
      records: untrackedPaths.map((path) => ({ kind: "added" as const, path })),
      layer: "untracked",
    },
  ]).filter(
    (file) =>
      relevant(file.path, config) ||
      (file.oldPath !== undefined && relevant(file.oldPath, config)),
  );

  const baselineTree = await git.listTree(baselineCommit);
  const headTree = await git.listTree(currentHead);
  const index = await git.listIndex();
  const paths = new Set<string>(untrackedPaths);
  addPaths(paths, committed, config);
  addPaths(paths, staged, config);
  addPaths(paths, unstaged, config);

  const baselineContent = new Map<string, Buffer>();
  const currentContent = new Map<string, Buffer>();
  const entries: FingerprintEntry[] = [];
  for (const path of [...paths].sort()) {
    const current = await worktreeEntry(git.root, path);
    if (current.content) currentContent.set(path, current.content);
    const baselineBytes = baselineTree.has(path)
      ? await git.showFile(baselineCommit, path)
      : null;
    if (baselineBytes) baselineContent.set(path, baselineBytes);
    const rename = changedFiles.find(
      (file) => file.kind === "renamed" && file.path === path,
    );
    entries.push({
      path,
      baseline: baselineTree.get(path) ?? null,
      head: headTree.get(path) ?? null,
      index: index.get(path) ?? [],
      worktree: current.entry,
      layers: layersFor(path, groups, untracked),
      ...(rename?.oldPath === undefined ? {} : { renameFrom: rename.oldPath }),
    });
  }

  const manifest: FingerprintManifestV1 = {
    schemaVersion: 1,
    baselineCommit,
    currentHead,
    policySourceCommit,
    trustedPolicyHash,
    entries,
  };

  const unmergedPaths = [...index.entries()]
    .filter(([, values]) => values.length > 1)
    .map(([path]) => path)
    .sort();
  return {
    root: git.root,
    baselineCommit,
    currentHead,
    policySourceCommit,
    trustedPolicyHash,
    fingerprint: sha256(canonicalJson(manifest)),
    manifest,
    changedFiles,
    baselineFiles: new Set(baselineTree.keys()),
    baselineContent,
    currentContent,
    unmergedPaths,
  };
}

export async function repositoryIdentifier(
  git: GitClient,
  commit: string,
): Promise<string> {
  const roots = await git.rootCommits(commit);
  return sha256(`judgelock-repository-v1\0${roots.join("\0")}`);
}
