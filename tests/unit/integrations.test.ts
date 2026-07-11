import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import {
  installClaudeCode,
  uninstallClaudeCode,
} from "../../src/integrations/claude-code";

const repositories: string[] = [];

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "judgelock-claude-code-"));
  repositories.push(root);
  await execa("git", ["init"], { cwd: root });
  return root;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    repositories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Claude Code integration", () => {
  it("merges exact hook groups, backs up prior bytes, and installs idempotently", async () => {
    const root = await temporaryRepository();
    const settingsPath = join(root, ".claude", "settings.json");
    await mkdir(join(root, ".claude"), { recursive: true });
    const original = `${JSON.stringify(
      {
        permissions: { allow: ["Bash(npm test)"] },
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "audit", args: [] }],
            },
          ],
        },
      },
      null,
      4,
    )}\n`;
    await writeFile(settingsPath, original);

    const first = await installClaudeCode(root);
    expect(first.changed).toBe(true);
    expect(first.backupPath).toBeDefined();
    expect(
      await readFile(
        join(first.backupPath!, ".claude", "settings.json"),
        "utf8",
      ),
    ).toBe(original);

    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      permissions: unknown;
      hooks: Record<string, Record<string, unknown>[]>;
    };
    expect(settings.permissions).toEqual({ allow: ["Bash(npm test)"] });
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "audit", args: [] }],
      },
      {
        matcher: "Edit|Write",
        hooks: [
          {
            type: "command",
            command: "node",
            args: [
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/judgelock.cjs",
              "can-write",
            ],
          },
        ],
      },
    ]);
    expect(settings.hooks.Stop).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: "node",
            args: [
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/judgelock.cjs",
              "can-stop",
            ],
          },
        ],
      },
    ]);
    expect(settings.hooks.Stop?.[0]).not.toHaveProperty("matcher");

    const second = await installClaudeCode(root);
    expect(second).toMatchObject({
      changed: false,
      launcherSha256: first.launcherSha256,
    });
    expect(second.backupPath).toBeUndefined();
  });

  it("uninstalls only JudgeLock-owned entries and files", async () => {
    const root = await temporaryRepository();
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(
      join(root, ".claude", "settings.json"),
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify" }] }] }, theme: "dark" })}\n`,
    );
    await installClaudeCode(root);

    const result = await uninstallClaudeCode(root);
    expect(result.changed).toBe(true);
    const settings = JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(settings).toEqual({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "notify" }] }] },
      theme: "dark",
    });
    expect(await exists(join(root, ".claude", "hooks", "judgelock.cjs"))).toBe(
      false,
    );
    expect(
      await exists(
        join(root, ".judgelock", "integrations", "claude-code.json"),
      ),
    ).toBe(false);

    const second = await uninstallClaudeCode(root);
    expect(second.changed).toBe(false);
  });

  it("refuses to overwrite or delete a modified owned launcher", async () => {
    const root = await temporaryRepository();
    await installClaudeCode(root);
    const launcherPath = join(root, ".claude", "hooks", "judgelock.cjs");
    await writeFile(
      launcherPath,
      `${await readFile(launcherPath, "utf8")}\n// local change\n`,
    );

    await expect(installClaudeCode(root)).rejects.toMatchObject({
      code: "CLAUDE_CODE_LAUNCHER_MODIFIED",
      exitCode: 8,
    });
    await expect(uninstallClaudeCode(root)).rejects.toMatchObject({
      code: "CLAUDE_CODE_LAUNCHER_MODIFIED",
      exitCode: 8,
    });
    expect(await exists(launcherPath)).toBe(true);
  });

  it("makes the generated launcher fail closed for malformed input and a missing CLI", async () => {
    const root = await temporaryRepository();
    await installClaudeCode(root);
    const launcherPath = join(root, ".claude", "hooks", "judgelock.cjs");

    const malformed = spawnSync(process.execPath, [launcherPath, "can-write"], {
      cwd: root,
      input: "not-json",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain("malformed Claude Code hook JSON");

    const missing = spawnSync(process.execPath, [launcherPath, "can-write"], {
      cwd: root,
      input: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "src/index.ts" },
        cwd: root,
      }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, JUDGELOCK_CLI_PATH: "" },
    });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("not installed in this project");
  });

  it("maps any JudgeLock CLI denial to Claude hook exit code 2", async () => {
    const root = await temporaryRepository();
    await installClaudeCode(root);
    const launcherPath = join(root, ".claude", "hooks", "judgelock.cjs");
    const fakeCli = join(root, "fake-cli.cjs");
    await writeFile(
      fakeCli,
      'process.stderr.write("write denied by policy\\n"); process.exit(4);\n',
    );

    const denied = spawnSync(process.execPath, [launcherPath, "can-write"], {
      cwd: root,
      input: JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "tests/example.test.ts" },
        cwd: root,
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        JUDGELOCK_CLI_PATH: fakeCli,
      },
    });
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain("write denied by policy");
  });

  it("forwards official Write and Stop payloads to the expected CLI commands", async () => {
    const root = await temporaryRepository();
    await installClaudeCode(root);
    const launcherPath = join(root, ".claude", "hooks", "judgelock.cjs");
    const fakeCli = join(root, "fake-cli.cjs");
    const capturePath = join(root, "captured-args.json");
    await writeFile(
      fakeCli,
      'require("node:fs").writeFileSync(process.env.JUDGELOCK_CAPTURE, JSON.stringify(process.argv.slice(2)));\n',
    );

    const writeResult = spawnSync(
      process.execPath,
      [launcherPath, "can-write"],
      {
        cwd: root,
        input: JSON.stringify({
          tool_name: "Write",
          tool_input: { file_path: "src/new file.ts" },
          cwd: root,
        }),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: root,
          JUDGELOCK_CLI_PATH: fakeCli,
          JUDGELOCK_CAPTURE: capturePath,
        },
      },
    );
    expect(writeResult.status).toBe(0);
    expect(JSON.parse(await readFile(capturePath, "utf8"))).toEqual([
      "hook",
      "can-write",
      "--path",
      "src/new file.ts",
      "--json",
    ]);

    const stopResult = spawnSync(process.execPath, [launcherPath, "can-stop"], {
      cwd: root,
      input: JSON.stringify({
        hook_event_name: "Stop",
        stop_hook_active: false,
        cwd: root,
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        JUDGELOCK_CLI_PATH: fakeCli,
        JUDGELOCK_CAPTURE: capturePath,
      },
    });
    expect(stopResult.status).toBe(0);
    expect(JSON.parse(await readFile(capturePath, "utf8"))).toEqual([
      "hook",
      "can-stop",
      "--json",
    ]);
  });
});
