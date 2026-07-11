import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults";
import { sha256 } from "../../src/util/hash";
import { verifyCi } from "../../src/verification/verify";
import { TestRepository } from "../helpers/git-repo";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repo) => repo.cleanup()));
});

async function repo(
  options: Parameters<typeof TestRepository.create>[0] = {},
): Promise<TestRepository> {
  const value = await TestRepository.create(options);
  repositories.push(value);
  return value;
}

describe("independent CI enforcement", () => {
  it("rejects a pull-request policy downgrade using the trusted base policy", async () => {
    const directory = await repo({ command: "node --test" });
    await directory.git(["checkout", "-b", "feature"]);
    const downgraded = (await directory.read("judgelock.yml"))
      .replace("existingTests: immutable", "existingTests: allowed")
      .replace(
        'command: "node --test"',
        'command: "node -e \\"process.exit(0)\\""',
      );
    await directory.write("judgelock.yml", downgraded);
    await directory.commit("weaken policy");

    const result = await verifyCi(directory.path, "main");
    expect(result.passed).toBe(false);
    expect(result.failureKind).toBe("policy");
    expect(
      result.receipt.payload.inspection.violations.map(
        (finding) => finding.code,
      ),
    ).toContain("CONFIG_CHANGED");
    expect(result.receipt.payload.commands).toEqual([]);
  });

  it("allows an explicitly permitted policy-file change but runs only the base command", async () => {
    const baseCommand =
      "node -e \"const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/base-command.txt','base')\"";
    const directory = await repo({
      command: baseCommand,
      allowPolicyChanges: true,
    });
    await directory.git(["checkout", "-b", "feature"]);
    const untrusted = DEFAULT_CONFIG.replace(
      "  commands: []",
      '  commands:\n    - name: tests\n      command: "node -e \\"process.exit(9)\\""\n      timeoutSeconds: 30',
    );
    await directory.write("judgelock.yml", untrusted);
    await directory.write(
      "src/math.js",
      "export function add(a, b) { return a + b; }\nexport const feature = true;\n",
    );
    await directory.commit("feature and untrusted policy");

    const result = await verifyCi(directory.path, "main");
    expect(result.passed).toBe(true);
    expect(result.receipt.payload.commands).toHaveLength(1);
    expect(result.receipt.payload.commands[0]).toMatchObject({
      status: "passed",
      commandHash: sha256(baseCommand),
    });
    await expect(
      access(join(directory.path, "dist", "base-command.txt")),
    ).resolves.toBeUndefined();
  });

  it("uses the merge base for the diff and the current base tip for policy", async () => {
    const directory = await repo({
      command: "node --test",
      allowPolicyChanges: true,
    });
    const original = await directory.git(["rev-parse", "HEAD"]);
    await directory.git(["checkout", "-b", "feature"]);
    await directory.write("src/feature.js", "export const feature = true;\n");
    await directory.commit("feature");
    await directory.git(["checkout", "main"]);
    await directory.write("README.md", "base advanced\n");
    await directory.commit("advance trusted base");
    const trustedTip = await directory.git(["rev-parse", "HEAD"]);
    await directory.git(["checkout", "feature"]);

    const result = await verifyCi(directory.path, "main");
    expect(result.receipt.payload.baselineCommit).toBe(original);
    expect(result.receipt.payload.policySourceCommit).toBe(trustedTip);
    expect(result.passed).toBe(true);
  });
});
