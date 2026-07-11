#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const keep = process.argv.slice(2).includes("--keep");
const unknownOptions = process.argv
  .slice(2)
  .filter((argument) => argument !== "--keep");

if (unknownOptions.length > 0) {
  process.stderr.write(
    `Unknown option: ${unknownOptions[0]}\nUsage: node examples/vulnerable-demo/demo.mjs [--keep]\n`,
  );
  process.exit(2);
}

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = path.join(projectRoot, "dist", "cli.js");
const demoRoot = await mkdtemp(path.join(tmpdir(), "judgelock-demo-"));

const originalTest = `import test from "node:test";
import assert from "node:assert/strict";
import { invoiceTotal } from "../src/invoice.mjs";

test("keeps a zero-discount invoice unchanged", () => {
  assert.equal(invoiceTotal(1000, 0), 1000);
});
`;

const vulnerableSource = `export function invoiceTotal(subtotalCents, discountRate) {
  // Bug: a discount is added instead of subtracted.
  return Math.round(subtotalCents * (1 + discountRate));
}
`;

const fixedSource = `export function invoiceTotal(subtotalCents, discountRate) {
  return Math.round(subtotalCents * (1 - discountRate));
}
`;

function printHeading(title) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function displayCommand(command, args) {
  const rendered = [command, ...args]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
  process.stdout.write(`$ ${rendered}\n`);
}

function run(command, args, options = {}) {
  const { expectedExit = 0, showOutput = true } = options;
  displayCommand(command, args);

  const result = spawnSync(command, args, {
    cwd: demoRoot,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    shell: false,
  });

  if (showOutput && result.stdout) process.stdout.write(result.stdout);
  if (showOutput && result.stderr) process.stderr.write(result.stderr);

  if (result.error) throw result.error;
  if (result.status !== expectedExit) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.status)}; expected ${expectedExit}.`,
    );
  }

  return result;
}

function git(...args) {
  return run("git", args, { showOutput: false });
}

function judgelock(args, expectedExit = 0) {
  return run(process.execPath, [cliPath, ...args], { expectedExit });
}

async function createBaseline() {
  git("init", "-b", "main");
  git("config", "user.name", "JudgeLock Demo");
  git("config", "user.email", "demo@judgelock.invalid");

  await mkdir(path.join(demoRoot, "src"), { recursive: true });
  await mkdir(path.join(demoRoot, "tests"), { recursive: true });
  await writeFile(
    path.join(demoRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "judgelock-vulnerable-demo",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { test: "node --test tests/*.test.mjs" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(demoRoot, "src", "invoice.mjs"), vulnerableSource);
  await writeFile(
    path.join(demoRoot, "tests", "invoice.test.mjs"),
    originalTest,
  );

  judgelock(["init"]);
  const configPath = path.join(demoRoot, "judgelock.yml");
  const defaultConfig = await readFile(configPath, "utf8");
  const configured = defaultConfig.replace(
    "validation:\n  protectScripts: true\n  commands: []",
    `validation:
  protectScripts: true
  commands:
    - name: tests
      command: npm test
      timeoutSeconds: 120`,
  );

  if (configured === defaultConfig) {
    throw new Error(
      "The generated JudgeLock configuration did not contain the expected default block.",
    );
  }

  await writeFile(configPath, configured);
  git("add", ".");
  git("commit", "-m", "Create vulnerable invoice baseline");
}

async function demonstrate() {
  printHeading("1. Create and start from a clean, committed baseline");
  await createBaseline();
  judgelock([
    "start",
    "--task",
    "Fix percentage discounts without weakening existing tests",
  ]);

  printHeading("2. A cheating edit to an existing test is blocked");
  await writeFile(
    path.join(demoRoot, "tests", "invoice.test.mjs"),
    originalTest.replace('test("keeps', 'test.skip("keeps'),
  );
  judgelock(["inspect"], 4);

  printHeading(
    "3. Restore baseline evidence, fix production code, and add a regression test",
  );
  await writeFile(
    path.join(demoRoot, "tests", "invoice.test.mjs"),
    originalTest,
  );
  await writeFile(path.join(demoRoot, "src", "invoice.mjs"), fixedSource);
  await writeFile(
    path.join(demoRoot, "tests", "invoice-discount.test.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { invoiceTotal } from "../src/invoice.mjs";

test("subtracts a percentage discount", () => {
  assert.equal(invoiceTotal(1000, 0.1), 900);
});
`,
  );
  judgelock(["inspect"]);
  judgelock(["verify"]);
  judgelock(["hook", "can-stop"]);

  printHeading("4. A later source change makes the receipt stale");
  await writeFile(
    path.join(demoRoot, "src", "invoice.mjs"),
    `${fixedSource}\n// This post-verification change was not covered by the receipt.\n`,
  );
  judgelock(["hook", "can-stop"], 6);

  printHeading("Demo complete");
  process.stdout.write(
    "JudgeLock blocked weakened evidence, accepted the add-only regression fix, and rejected a stale receipt.\n",
  );
}

try {
  await demonstrate();

  if (keep) {
    process.stdout.write(`\nKept demo repository: ${demoRoot}\n`);
    process.stdout.write("Explore it with:\n");
    process.stdout.write(`  cd ${JSON.stringify(demoRoot)}\n`);
    process.stdout.write(
      `  ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} status\n`,
    );
    process.stdout.write(
      `  ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} inspect\n`,
    );
    process.stdout.write(
      `  ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} verify\n`,
    );
  } else {
    await rm(demoRoot, { recursive: true, force: true });
  }
} catch (error) {
  process.stderr.write(
    `\nDemo failed. Repository retained for diagnosis: ${demoRoot}\n`,
  );
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
}
