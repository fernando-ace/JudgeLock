import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function atomicWriteFile(
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, path);
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST" && code !== "EPERM") {
      await rm(temporary, { force: true });
      throw error;
    }
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
