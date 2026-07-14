import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

function run(command, args, cwd, expectedExit = 0) {
  const commandShim = command.endsWith(".cmd");
  const spawnArguments = commandShim
    ? args.map((argument) =>
        /[\s"]/u.test(argument)
          ? `"${argument.replaceAll('"', '""')}"`
          : argument,
      )
    : args;
  const result = spawnSync(command, spawnArguments, {
    cwd,
    encoding: "utf8",
    shell: commandShim,
    windowsHide: true,
  });
  const exitCode = result.status ?? 1;
  if (exitCode !== expectedExit) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${exitCode}, expected ${expectedExit}\n${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return { exitCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(root, ...args) {
  return run("git", args, root).stdout.trim();
}

function write(root, path, contents) {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function read(root, path) {
  return readFileSync(join(root, ...path.split("/")), "utf8");
}

function npx(root, ...args) {
  return run(npxCommand, ["--no-install", "judgelock", ...args], root);
}

function npxExpected(root, expectedExit, ...args) {
  return run(
    npxCommand,
    ["--no-install", "judgelock", ...args],
    root,
    expectedExit,
  );
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "judgelock-release-smoke-"));
try {
  const packDirectory = join(temporaryRoot, "pack");
  mkdirSync(packDirectory);
  run(
    npmCommand,
    ["pack", "--json", "--pack-destination", packDirectory],
    sourceRoot,
  );
  const tarballs = readdirSync(packDirectory).filter((name) =>
    name.endsWith(".tgz"),
  );
  if (tarballs.length !== 1)
    throw new Error(`Expected one package tarball, found ${tarballs.length}.`);
  const tarball = join(packDirectory, tarballs[0]);
  const entries = run("tar", ["-tf", tarball], sourceRoot)
    .stdout.split(/\r?\n/u)
    .filter(Boolean)
    .map((entry) => entry.replace(/^package\//u, ""))
    .sort();
  const required = [
    "dist/cli.js",
    "dist/index.js",
    "dist/index.d.ts",
    "package.json",
    "README.md",
    "LICENSE",
  ];
  for (const path of required) {
    if (!entries.includes(path)) throw new Error(`Tarball is missing ${path}.`);
  }
  const prohibited = entries.filter(
    (entry) =>
      entry.endsWith(".map") ||
      /^(?:tests|benchmark|scripts|\.judgelock)(?:\/|$)/u.test(entry) ||
      /(?:^|\/)(?:\.env(?:\.|$)|.*(?:secret|token|credential).*)/iu.test(entry),
  );
  if (prohibited.length > 0)
    throw new Error(
      `Tarball contains prohibited files: ${prohibited.join(", ")}`,
    );

  const consumer = join(temporaryRoot, "consumer");
  mkdirSync(consumer);
  write(
    consumer,
    "package.json",
    `${JSON.stringify({ name: "judgelock-release-consumer", private: true, type: "module" })}\n`,
  );
  run(npmCommand, ["install", "--save-dev", tarball], consumer);
  const version = npx(consumer, "--version").stdout.trim();
  if (version !== "0.1.0-beta.1")
    throw new Error(`Unexpected installed version ${version}.`);

  git(consumer, "init", "-b", "main");
  git(consumer, "config", "user.name", "JudgeLock Release Smoke");
  git(consumer, "config", "user.email", "release-smoke@judgelock.invalid");
  git(consumer, "config", "commit.gpgsign", "false");
  git(consumer, "config", "core.autocrlf", "false");
  npx(consumer, "init");
  const configuredPolicy = read(consumer, "judgelock.yml").replace(
    "  commands: []",
    '  commands:\n    - name: tests\n      command: "node --test tests/runtime.test.mjs"\n      timeoutSeconds: 30',
  );
  write(consumer, "judgelock.yml", configuredPolicy);
  write(
    consumer,
    "src/math.js",
    "export function add(a, b) { return a + b; }\n",
  );
  write(
    consumer,
    "tests/runtime.test.mjs",
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('adds', () => assert.equal(add(2, 3), 5));\n",
  );
  git(consumer, "add", "-A");
  git(consumer, "commit", "-m", "baseline");
  npx(consumer, "start", "--task", "Packed package release smoke");
  git(consumer, "checkout", "-b", "feature");
  write(
    consumer,
    "src/math.js",
    "export function add(a, b) { return Number(a) + Number(b); }\n",
  );
  write(
    consumer,
    "tests/regression.test.mjs",
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('numeric strings', () => assert.equal(add('2', '3'), 5));\n",
  );
  npx(consumer, "inspect");
  npx(consumer, "verify");
  npx(consumer, "hook", "can-stop");
  const status = JSON.parse(npx(consumer, "status", "--json").stdout);
  if (
    status.result?.evidenceValid !== true ||
    status.result?.completionAuthorized !== true ||
    status.result?.inspectionOnly !== false
  ) {
    throw new Error("Packed status JSON did not authorize full verification.");
  }
  write(
    consumer,
    "src/math.js",
    `${read(consumer, "src/math.js")}export const receiptIsNowStale = true;\n`,
  );
  npxExpected(consumer, 6, "hook", "can-stop", "--json");
  git(consumer, "add", "-A");
  git(consumer, "commit", "-m", "feature");
  npx(consumer, "ci", "--base-ref", "main");

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        packageVersion: version,
        tarballEntries: entries.length,
        installedOutsideSourceTree: true,
        receiptFreshnessVerified: true,
        staleReceiptBlocked: true,
        trustedBaseCiPassed: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
