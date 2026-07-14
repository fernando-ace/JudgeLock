import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSafeRepositoryPath } from "../../src/util/safe-path";

describe("safe repository path aliases", () => {
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    if (temporaryRoot)
      await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("accepts a file whose repository alias resolves to the same real path", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "judgelock-path-alias-"));
    const realRoot = join(temporaryRoot, "real-root");
    const aliasRoot = join(temporaryRoot, "alias-root");
    await mkdir(join(realRoot, "tests"), { recursive: true });
    await writeFile(join(realRoot, "tests", "math.test.js"), "test\n");
    await symlink(realRoot, aliasRoot, "junction");

    await expect(
      resolveSafeRepositoryPath(aliasRoot, "tests/math.test.js"),
    ).resolves.toMatchObject({ relative: "tests/math.test.js" });
  });
});
