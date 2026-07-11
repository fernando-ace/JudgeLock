import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canWrite } from "../../src/commands/hooks";
import { startSession } from "../../src/commands/start";
import { DEFAULT_CONFIG } from "../../src/config/defaults";
import { verifyLocal } from "../../src/verification/verify";
import { TestRepository } from "../helpers/git-repo";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repo) => repo.cleanup()));
});

async function repo(): Promise<TestRepository> {
  const value = await TestRepository.create();
  repositories.push(value);
  return value;
}

function configWithCommands(commands: string): string {
  return DEFAULT_CONFIG.replace("  commands: []", commands);
}

describe("verification failure edges", () => {
  it("continues after a failed required command only when requested", async () => {
    const directory = await repo();
    await directory.write(
      "judgelock.yml",
      configWithCommands(
        "  commands:\n    - name: fail\n      command: \"node -e \\\"process.exit(2)\\\"\"\n      timeoutSeconds: 10\n    - name: after\n      command: \"node -e \\\"const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/continued.txt','yes')\\\"\"\n      timeoutSeconds: 10",
      ),
    );
    await directory.commit("configure two checks");
    await startSession(directory.path, "Continue checks");
    const result = await verifyLocal(directory.path, true);
    expect(result.passed).toBe(false);
    expect(
      result.receipt.payload.commands.map((command) => command.status),
    ).toEqual(["failed", "passed"]);
    await expect(
      access(join(directory.path, "dist", "continued.txt")),
    ).resolves.toBeUndefined();
  });

  it("fails when a required command mutates relevant repository state", async () => {
    const directory = await repo();
    await directory.write(
      "judgelock.yml",
      configWithCommands(
        "  commands:\n    - name: mutate\n      command: \"node -e \\\"require('node:fs').writeFileSync('src/generated.js','export const generated = true;\\\\n')\\\"\"\n      timeoutSeconds: 10",
      ),
    );
    await directory.commit("configure mutating check");
    await startSession(directory.path, "Detect command mutation");
    const result = await verifyLocal(directory.path, false);
    expect(result.passed).toBe(false);
    expect(result.failureKind).toBe("state-changed");
    expect(result.receipt.payload.failureReason).toMatch(
      /changed during verification/u,
    );
  });

  it("fails closed when an existing session file is corrupt", async () => {
    const directory = await repo();
    await startSession(directory.path, "Corrupt state");
    await directory.write(".judgelock/session.json", "not json\n");
    await expect(canWrite(directory.path, "src/math.js")).rejects.toMatchObject(
      { exitCode: 7, code: "SESSION_STATE_CORRUPT" },
    );
  });
});
