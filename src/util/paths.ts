import micromatch from "micromatch";
import type { JudgeLockConfig } from "../config/schema";

export function normalizeRepoPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/gu, "/");
}

export function matches(path: string, patterns: string[]): boolean {
  return micromatch.isMatch(normalizeRepoPath(path), patterns, {
    dot: true,
    nonegate: true,
  });
}

export function isTestPath(path: string, config: JudgeLockConfig): boolean {
  return matches(path, config.paths.testPatterns);
}

export function isSnapshotPath(path: string, config: JudgeLockConfig): boolean {
  return matches(path, config.paths.snapshotPatterns);
}

export function isProtectedPath(
  path: string,
  config: JudgeLockConfig,
): boolean {
  return matches(path, config.paths.protectedPatterns);
}

export function isIgnoredPath(path: string, config: JudgeLockConfig): boolean {
  const normalized = normalizeRepoPath(path);
  if (
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized === ".judgelock" ||
    normalized.startsWith(".judgelock/")
  ) {
    return true;
  }
  if (isProtectedPath(normalized, config)) return false;
  return matches(normalized, config.paths.ignoredPatterns);
}
