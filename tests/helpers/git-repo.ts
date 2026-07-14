import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { DEFAULT_CONFIG } from "../../src/config/defaults";

export class TestRepository {
  readonly path: string;

  private constructor(path: string) {
    this.path = path;
  }

  static async create(
    options: {
      command?: string;
      allowPolicyChanges?: boolean;
      allowInspectionOnlyCompletion?: boolean;
    } = {},
  ): Promise<TestRepository> {
    const path = await mkdtemp(join(tmpdir(), "judgelock-test-"));
    const repo = new TestRepository(path);
    await repo.git(["init", "-b", "main"]);
    await repo.git(["config", "user.name", "JudgeLock Tests"]);
    await repo.git(["config", "user.email", "judgelock@example.invalid"]);
    await repo.git(["config", "commit.gpgsign", "false"]);
    await repo.git(["config", "core.autocrlf", "false"]);
    let config = DEFAULT_CONFIG;
    if (options.command) {
      config = config.replace(
        "  commands: []",
        `  commands:\n    - name: tests\n      command: ${JSON.stringify(options.command)}\n      timeoutSeconds: 30`,
      );
    }
    if (options.allowPolicyChanges)
      config = config.replace(
        "allowPolicyChanges: false",
        "allowPolicyChanges: true",
      );
    if (options.allowInspectionOnlyCompletion)
      config = config.replace(
        "allowInspectionOnlyCompletion: false",
        "allowInspectionOnlyCompletion: true",
      );
    await repo.write("judgelock.yml", config);
    await repo.write(".gitignore", "/.judgelock/\n/node_modules/\n/dist/\n");
    await repo.write(
      "package.json",
      '{"name":"fixture","private":true,"type":"module","scripts":{"test":"node --test"}}\n',
    );
    await repo.write(
      "src/math.js",
      "export function add(a, b) { return a + b; }\n",
    );
    await repo.write(
      "tests/math.test.js",
      'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.js";\n\ntest("adds", () => {\n  assert.equal(add(2, 3), 5);\n});\n',
    );
    await repo.commit("baseline");
    return repo;
  }

  async git(args: string[]): Promise<string> {
    const result = await execa("git", args, { cwd: this.path });
    return result.stdout;
  }

  async write(relativePath: string, contents: string): Promise<void> {
    const path = join(this.path, ...relativePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }

  async read(relativePath: string): Promise<string> {
    return readFile(join(this.path, ...relativePath.split("/")), "utf8");
  }

  async remove(relativePath: string): Promise<void> {
    await rm(join(this.path, ...relativePath.split("/")), {
      force: true,
      recursive: true,
    });
  }

  async commit(message: string): Promise<void> {
    await this.git(["add", "-A"]);
    await this.git(["commit", "-m", message]);
  }

  async cleanup(): Promise<void> {
    await rm(this.path, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}
