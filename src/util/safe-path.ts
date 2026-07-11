import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeRepoPath } from "./paths";

export function isPathInside(root: string, candidate: string): boolean {
  const result = relative(resolve(root), resolve(candidate));
  return (
    result === "" ||
    (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result))
  );
}

export async function resolveSafeRepositoryPath(
  root: string,
  suppliedPath: string,
): Promise<{ absolute: string; relative: string }> {
  const absolute = isAbsolute(suppliedPath)
    ? resolve(suppliedPath)
    : resolve(root, suppliedPath);
  if (!isPathInside(root, absolute))
    throw new Error("Path is outside the repository.");
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink())
      throw new Error("Writes through symbolic links are not allowed.");
    const resolved = await realpath(absolute);
    if (!isPathInside(root, resolved))
      throw new Error("Path resolves outside the repository.");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }
  return { absolute, relative: normalizeRepoPath(relative(root, absolute)) };
}
