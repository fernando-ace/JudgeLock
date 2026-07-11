import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canStop, canWrite } from "../../src/commands/hooks";
import { initializePolicy } from "../../src/commands/init";
import { inspectLocal } from "../../src/commands/inspect";
import { startSession } from "../../src/commands/start";
import { getStatus } from "../../src/commands/status";
import { ExitCode } from "../../src/constants";
import { GitClient } from "../../src/git/client";
import { captureRepositoryState } from "../../src/git/state";
import { validateActiveReceipt } from "../../src/receipts/validate";
import { loadTrustedSessionContext } from "../../src/state/session";
import { verifyLocal } from "../../src/verification/verify";
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

describe("initialization and session prerequisites", () => {
  it("initializes outside Git, deduplicates ignore state, and refuses overwrite", async () => {
    const directory = await repo();
    await directory.remove("judgelock.yml");
    await directory.write(".gitignore", "/.judgelock/\n");
    const result = await initializePolicy(directory.path, false);
    expect(result.created).toContain("judgelock.yml");
    expect(
      (await directory.read(".gitignore")).match(/judgelock/gu),
    ).toHaveLength(1);
    await expect(initializePolicy(directory.path, false)).rejects.toMatchObject(
      { code: "CONFIG_EXISTS", exitCode: 2 },
    );
    await expect(initializePolicy(directory.path, true)).resolves.toMatchObject(
      { updated: ["judgelock.yml"] },
    );
  });

  it("rejects starts outside Git and from a dirty tree", async () => {
    const temporary = await repo();
    await temporary.write("dirty.txt", "dirty\n");
    await expect(startSession(temporary.path, "task")).rejects.toMatchObject({
      code: "DIRTY_WORKING_TREE",
      exitCode: 3,
    });
  });

  it("starts from a clean committed policy", async () => {
    const directory = await repo();
    const result = await startSession(directory.path, "Fix addition");
    expect(result.protectedTests).toBe(1);
    expect(result.session.task).toBe("Fix addition");
    await expect(
      access(join(directory.path, ".judgelock", "session.json")),
    ).resolves.toBeUndefined();
  });
});

describe("inspection", () => {
  it("allows production-only changes and honest new tests", async () => {
    const directory = await repo();
    await startSession(directory.path, "Improve addition");
    await directory.write(
      "src/math.js",
      "export function add(a, b) { return Number(a) + Number(b); }\n",
    );
    await directory.write(
      "tests/regression.test.js",
      'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.js";\ntest("numeric strings", () => assert.equal(add("2", "3"), 5));\n',
    );
    const result = await inspectLocal(directory.path);
    expect(result.inspection.status).toBe("passed");
  });

  it("blocks immutable edits, deletion, rename, skip, and focus", async () => {
    const directory = await repo();
    await startSession(directory.path, "Cheat attempt");
    await directory.write(
      "tests/math.test.js",
      (await directory.read("tests/math.test.js")).replace(
        'test("adds"',
        'test.skip("adds"',
      ),
    );
    let result = await inspectLocal(directory.path);
    expect(result.inspection.violations.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["EXISTING_TEST_MODIFIED", "SKIPPED_TEST_ADDED"]),
    );

    const other = await repo();
    await startSession(other.path, "Rename test");
    await other.git(["mv", "tests/math.test.js", "tests/renamed.test.js"]);
    result = await inspectLocal(other.path);
    expect(
      result.inspection.violations.map((finding) => finding.code),
    ).toContain("TEST_RENAMED");

    const deleted = await repo();
    await startSession(deleted.path, "Delete test");
    await deleted.remove("tests/math.test.js");
    result = await inspectLocal(deleted.path);
    expect(
      result.inspection.violations.map((finding) => finding.code),
    ).toContain("TEST_DELETED");

    const focused = await repo();
    await startSession(focused.path, "Focused new test");
    await focused.write(
      "tests/focus.test.js",
      'import test from "node:test";\ntest.only("only", () => {});\n',
    );
    result = await inspectLocal(focused.path);
    expect(
      result.inspection.violations.map((finding) => finding.code),
    ).toContain("FOCUSED_TEST_ADDED");
  });

  it("fingerprints staging changes and ignores configured build output", async () => {
    const directory = await repo();
    await startSession(directory.path, "Fingerprint layers");
    await directory.write("src/new.js", "export const value = 1;\n");
    const context = await loadTrustedSessionContext(directory.path);
    const before = await captureRepositoryState({
      git: context.git,
      baselineCommit: context.session.baselineCommit,
      policySourceCommit: context.session.policySourceCommit,
      trustedPolicyHash: context.session.trustedPolicyHash,
      config: context.config,
    });
    await directory.git(["add", "src/new.js"]);
    const staged = await captureRepositoryState({
      git: context.git,
      baselineCommit: context.session.baselineCommit,
      policySourceCommit: context.session.policySourceCommit,
      trustedPolicyHash: context.session.trustedPolicyHash,
      config: context.config,
    });
    expect(staged.fingerprint).not.toBe(before.fingerprint);
    await directory.write("dist/generated.js", "ignored\n");
    const ignored = await captureRepositoryState({
      git: context.git,
      baselineCommit: context.session.baselineCommit,
      policySourceCommit: context.session.policySourceCommit,
      trustedPolicyHash: context.session.trustedPolicyHash,
      config: context.config,
    });
    expect(ignored.fingerprint).toBe(staged.fingerprint);
  });
});

describe("verification and hooks", () => {
  it("creates a valid receipt and invalidates it after a relevant change", async () => {
    const directory = await repo({ command: "node --test" });
    await startSession(directory.path, "Verify addition");
    await directory.write(
      "src/math.js",
      "export function add(a, b) { return a + b; }\n\nexport const identity = (value) => value;\n",
    );
    const result = await verifyLocal(directory.path, false);
    expect(result.passed).toBe(true);
    expect(result.receipt.payload.commands[0]?.status).toBe("passed");
    await expect(validateActiveReceipt(directory.path)).resolves.toMatchObject({
      valid: true,
    });
    await expect(canStop(directory.path)).resolves.toMatchObject({
      exitCode: ExitCode.OK,
    });
    await directory.write(
      "src/math.js",
      `${await directory.read("src/math.js")}export const changed = true;\n`,
    );
    await expect(validateActiveReceipt(directory.path)).resolves.toMatchObject({
      valid: false,
    });
    await expect(canStop(directory.path)).resolves.toMatchObject({
      exitCode: ExitCode.COMPLETION_BLOCKED,
    });
  });

  it("keeps failed command evidence separate and invalidates an older pass", async () => {
    const directory = await repo({ command: 'node -e "process.exit(7)"' });
    await startSession(directory.path, "Fail verification");
    const result = await verifyLocal(directory.path, false);
    expect(result.passed).toBe(false);
    expect(result.failureKind).toBe("command");
    expect(result.receipt.payload.finalStatus).toBe("failed");
    await expect(validateActiveReceipt(directory.path)).resolves.toMatchObject({
      valid: false,
    });
  });

  it("supports inspection-only receipts with an explicit warning", async () => {
    const directory = await repo();
    await startSession(directory.path, "Inspection only");
    const result = await verifyLocal(directory.path, false);
    expect(result.passed).toBe(true);
    expect(result.receipt.payload.commands).toEqual([]);
    expect((await getStatus(directory.path)).warning).toMatch(
      /NO_VALIDATION_COMMANDS/u,
    );
  });

  it("makes early write decisions and fails completion closed", async () => {
    const directory = await repo();
    await expect(
      canWrite(directory.path, "tests/new.test.js"),
    ).resolves.toMatchObject({ exitCode: 0 });
    await startSession(directory.path, "Hook decisions");
    await expect(
      canWrite(directory.path, "tests/math.test.js"),
    ).resolves.toMatchObject({
      exitCode: 4,
      decision: { reasonCode: "EXISTING_TEST_MODIFIED" },
    });
    await expect(
      canWrite(directory.path, "judgelock.yml"),
    ).resolves.toMatchObject({ exitCode: 4 });
    await expect(
      canWrite(directory.path, "tests/new.test.js"),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(canStop(directory.path)).resolves.toMatchObject({
      exitCode: 6,
    });
  });

  it("requires a Git repository for the Git client", async () => {
    const directory = await repo();
    const nested = join(directory.path, "outside");
    await directory.write("outside/file.txt", "x");
    expect((await GitClient.discover(nested)).root).toBe(
      directory.path.replaceAll("\\", "/"),
    );
  });

  it("stores only redacted retained command output", async () => {
    const directory = await repo({
      command: "node -e \"console.log('TOKEN=super-secret-token')\"",
    });
    await startSession(directory.path, "Redact output");
    const result = await verifyLocal(directory.path, false);
    expect(result.passed).toBe(true);
    const receiptText = await readFile(
      join(directory.path, result.receiptPath),
      "utf8",
    );
    expect(receiptText).not.toContain("super-secret-token");
    expect(receiptText).toContain("[REDACTED]");
  });
});
