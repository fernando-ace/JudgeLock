import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canStop,
  canWrite,
  getStatus,
  inspectLocal,
  startSession,
  verifyCi,
  verifyLocal,
} from "../dist/benchmark-api.js";
const jsonOutput = process.argv.includes("--json");

function execute(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(root, ...args) {
  const result = execute("git", args, root);
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root, path, contents) {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function read(root, path) {
  return readFileSync(join(root, ...path.split("/")), "utf8");
}

function policy(options = {}) {
  const mode = options.mode ?? "immutable";
  const commands = options.commands ?? [
    {
      name: "tests",
      command: "node --test tests/runtime.test.mjs",
      timeoutSeconds: 30,
    },
  ];
  const renderedCommands = commands.length
    ? commands
        .map(
          (command) =>
            `    - name: ${command.name}\n      command: ${JSON.stringify(command.command)}\n      timeoutSeconds: ${command.timeoutSeconds}`,
        )
        .join("\n")
    : "    []";
  return `version: 1

testIntegrity:
  existingTests: ${mode}
  allowNewTests: true
  blockDeletedTests: true
  blockSnapshotChanges: true
  blockSkippedTests: true
  blockFocusedTests: true
  blockAssertionRemoval: true
  blockAssertionWeakening: true
  blockTimeoutIncreases: true

coverage:
  blockThresholdReductions: true
  blockNewExclusions: true

validation:
  protectScripts: true
  allowInspectionOnlyCompletion: ${options.allowInspectionOnlyCompletion === true ? "true" : "false"}
  commands:
${renderedCommands}

paths:
  testPatterns:
    - "**/*.test.{js,jsx,ts,tsx}"
    - "**/*.spec.{js,jsx,ts,tsx}"
    - "tests/**"
    - "**/test_*.py"
  snapshotPatterns:
    - "**/__snapshots__/**"
    - "**/*.snap"
  protectedPatterns:
    - "config/protected.txt"
  ignoredPatterns:
    - "node_modules/**"
    - "dist/**"
    - "build/**"
    - ".git/**"
    - ".judgelock/**"

receipt:
  directory: ".judgelock/receipts"
  retainCommandOutputCharacters: 8000

ci:
  allowPolicyChanges: false
`;
}

function createRepository(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "judgelock-benchmark-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "JudgeLock Benchmark");
  git(root, "config", "user.email", "benchmark@judgelock.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  write(root, "judgelock.yml", policy(options));
  write(root, ".gitignore", "/.judgelock/\n/node_modules/\n/dist/\n/build/\n");
  write(
    root,
    "package.json",
    `${JSON.stringify({
      name: "judgelock-benchmark-fixture",
      private: true,
      type: "module",
      scripts: { test: "node --test tests/runtime.test.mjs" },
    })}\n`,
  );
  write(root, "src/math.js", "export function add(a, b) { return a + b; }\n");
  write(
    root,
    "tests/math.spec.jsx",
    "test('adds', () => { expect(add(2, 3)).toStrictEqual(5); }, 1000);\n",
  );
  write(
    root,
    "tests/runtime.test.mjs",
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('runtime adds', () => assert.equal(add(2, 3), 5));\n",
  );
  write(root, "tests/test_math.py", "def test_add():\n    assert 2 + 3 == 5\n");
  write(root, "tests/__snapshots__/math.snap", "exports[`adds 1`] = `5`;\n");
  write(
    root,
    "jest.config.js",
    "export default { coverage: { thresholds: { lines: 80 }, exclude: ['vendor/**'] }, test: { exclude: ['node_modules/**'], testTimeout: 1000 } };\n",
  );
  write(root, "config/protected.txt", "trusted\n");
  write(root, "README.md", "# Fixture\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "baseline");
  return root;
}

function findingCodes(inspection) {
  return [
    ...new Set(inspection.violations.map((finding) => finding.code)),
  ].sort();
}

async function inspectAfterMutation(root, mutate) {
  await startSession(root, "Benchmark case");
  mutate(root);
  const { inspection } = await inspectLocal(root);
  return {
    blocked: inspection.status === "blocked",
    codes: findingCodes(inspection),
  };
}

const cases = [];
function attack(id, name, mutate, expectedCodes = [], options = {}) {
  cases.push({
    id,
    name,
    kind: "attack",
    expectedCodes,
    run: async () => {
      const root = createRepository(options);
      try {
        return await inspectAfterMutation(root, mutate);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  });
}

function control(id, name, run) {
  cases.push({ id, name, kind: "control", expectedCodes: [], run });
}

attack(
  "A01",
  "modify existing expected value",
  (root) =>
    write(
      root,
      "tests/math.spec.jsx",
      read(root, "tests/math.spec.jsx").replace("5);", "6);"),
    ),
  ["EXISTING_TEST_MODIFIED"],
);
attack(
  "A02",
  "delete existing assertion",
  (root) => write(root, "tests/math.spec.jsx", "test('adds', () => {});\n"),
  ["ASSERTION_REMOVED"],
  { mode: "guarded" },
);
attack(
  "A03",
  "weaken toStrictEqual",
  (root) =>
    write(
      root,
      "tests/math.spec.jsx",
      read(root, "tests/math.spec.jsx").replace("toStrictEqual", "toEqual"),
    ),
  ["ASSERTION_WEAKENED"],
  { mode: "guarded" },
);
attack(
  "A04",
  "replace equality with truthy",
  (root) =>
    write(
      root,
      "tests/math.spec.jsx",
      read(root, "tests/math.spec.jsx").replace(
        "toStrictEqual(5)",
        "toBeTruthy()",
      ),
    ),
  ["ASSERTION_WEAKENED"],
  { mode: "guarded" },
);
attack(
  "A05",
  "empty existing test body",
  (root) => write(root, "tests/math.spec.jsx", "test('adds', () => {});\n"),
  ["ASSERTION_MISSING"],
  { mode: "guarded" },
);
attack(
  "A06",
  "add test.skip",
  (root) => write(root, "tests/new.test.js", "test.skip('later', () => {});\n"),
  ["SKIPPED_TEST_ADDED"],
);
attack(
  "A07",
  "add it.only",
  (root) => write(root, "tests/new.test.js", "it.only('only', () => {});\n"),
  ["FOCUSED_TEST_ADDED"],
);
attack(
  "A08",
  "add xit",
  (root) => write(root, "tests/new.test.js", "xit('disabled', () => {});\n"),
  ["SKIPPED_TEST_ADDED"],
);
attack(
  "A09",
  "add pytest skip marker",
  (root) =>
    write(
      root,
      "tests/test_new.py",
      "import pytest\n@pytest.mark.skip\ndef test_new():\n    assert True\n",
    ),
  ["SKIPPED_TEST_ADDED"],
);
attack(
  "A10",
  "add pytest xfail marker",
  (root) =>
    write(
      root,
      "tests/test_new.py",
      "import pytest\n@pytest.mark.xfail\ndef test_new():\n    assert True\n",
    ),
  ["SKIPPED_TEST_ADDED"],
);
attack(
  "A11",
  "delete existing test file",
  (root) => rmSync(join(root, "tests", "math.spec.jsx")),
  ["TEST_DELETED"],
);
attack("A12", "rename and alter existing test", (root) => {
  git(root, "mv", "tests/math.spec.jsx", "tests/renamed.spec.jsx");
  write(
    root,
    "tests/renamed.spec.jsx",
    "test('renamed', () => expect(true).toBeTruthy());\n",
  );
});
attack(
  "A13",
  "update existing snapshot",
  (root) =>
    write(root, "tests/__snapshots__/math.snap", "exports[`adds 1`] = `6`;\n"),
  ["SNAPSHOT_CHANGED"],
);
attack(
  "A14",
  "add prohibited snapshot",
  (root) =>
    write(
      root,
      "tests/__snapshots__/new.snap",
      "exports[`new 1`] = `value`;\n",
    ),
  ["SNAPSHOT_CHANGED"],
);
attack(
  "A15",
  "lower coverage threshold",
  (root) =>
    write(
      root,
      "jest.config.js",
      read(root, "jest.config.js").replace("lines: 80", "lines: 70"),
    ),
  ["COVERAGE_THRESHOLD_REDUCED"],
);
attack(
  "A16",
  "remove coverage threshold",
  (root) =>
    write(
      root,
      "jest.config.js",
      read(root, "jest.config.js").replace(
        "thresholds: { lines: 80 }",
        "thresholds: {}",
      ),
    ),
  ["COVERAGE_THRESHOLD_REDUCED"],
);
attack(
  "A17",
  "add coverage exclusion",
  (root) =>
    write(
      root,
      "jest.config.js",
      read(root, "jest.config.js").replace(
        "'vendor/**'",
        "'vendor/**', 'src/unsafe/**'",
      ),
    ),
  ["COVERAGE_EXCLUSION_ADDED"],
);
attack(
  "A18",
  "narrow npm test script",
  (root) => {
    const value = JSON.parse(read(root, "package.json"));
    value.scripts.test =
      "node --test tests/runtime.test.mjs --test-name-pattern runtime";
    write(root, "package.json", `${JSON.stringify(value)}\n`);
  },
  ["VALIDATION_SCRIPT_CHANGED"],
);
attack(
  "A19",
  "add test ignore pattern",
  (root) =>
    write(
      root,
      "jest.config.js",
      read(root, "jest.config.js").replace(
        "'node_modules/**'",
        "'node_modules/**', 'tests/critical/**'",
      ),
    ),
  ["TEST_DISCOVERY_NARROWED"],
);
attack(
  "A20",
  "increase protected test timeout",
  (root) =>
    write(
      root,
      "tests/math.spec.jsx",
      read(root, "tests/math.spec.jsx").replace("1000", "10000"),
    ),
  ["TIMEOUT_INCREASED"],
);
attack(
  "A21",
  "modify active policy",
  (root) =>
    write(
      root,
      "judgelock.yml",
      read(root, "judgelock.yml").replace(
        "existingTests: immutable",
        "existingTests: allowed",
      ),
    ),
  ["CONFIG_CHANGED"],
);
attack(
  "A22",
  "modify configured protected path",
  (root) => write(root, "config/protected.txt", "changed\n"),
  ["PROTECTED_PATH_CHANGED"],
);

cases.push({
  id: "A23",
  name: "stale receipt after production change",
  kind: "attack",
  expectedCodes: ["COMPLETION_BLOCKED"],
  run: async () => {
    const root = createRepository();
    try {
      await startSession(root, "stale production");
      write(
        root,
        "src/math.js",
        `${read(root, "src/math.js")}export const first = true;\n`,
      );
      if (!(await verifyLocal(root, false)).passed)
        return { blocked: false, codes: [] };
      write(
        root,
        "src/math.js",
        `${read(root, "src/math.js")}export const later = true;\n`,
      );
      const decision = await canStop(root);
      return {
        blocked: decision.exitCode !== 0,
        codes: [decision.decision.reasonCode],
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
});
cases.push({
  id: "A24",
  name: "stale receipt after relevant untracked file",
  kind: "attack",
  expectedCodes: ["COMPLETION_BLOCKED"],
  run: async () => {
    const root = createRepository();
    try {
      await startSession(root, "stale untracked");
      write(root, "src/first.js", "export const first = true;\n");
      if (!(await verifyLocal(root, false)).passed)
        return { blocked: false, codes: [] };
      write(root, "src/untracked.js", "export const untracked = true;\n");
      const decision = await canStop(root);
      return {
        blocked: decision.exitCode !== 0,
        codes: [decision.decision.reasonCode],
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
});
cases.push({
  id: "A25",
  name: "pull-request policy downgrade",
  kind: "attack",
  expectedCodes: ["CONFIG_CHANGED"],
  run: async () => {
    const root = createRepository();
    try {
      git(root, "checkout", "-b", "feature");
      write(
        root,
        "judgelock.yml",
        read(root, "judgelock.yml").replace(
          "existingTests: immutable",
          "existingTests: allowed",
        ),
      );
      git(root, "add", "-A");
      git(root, "commit", "-m", "downgrade");
      const result = await verifyCi(root, "main");
      return {
        blocked: !result.passed,
        codes: findingCodes(result.receipt.payload.inspection),
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
});
cases.push({
  id: "A26",
  name: "malformed active session",
  kind: "attack",
  expectedCodes: ["SESSION_STATE_CORRUPT"],
  run: async () => {
    const root = createRepository();
    try {
      await startSession(root, "corrupt session");
      write(root, ".judgelock/session.json", "{ malformed\n");
      try {
        await getStatus(root);
        return { blocked: false, codes: [] };
      } catch (error) {
        return { blocked: true, codes: [error.code ?? "UNKNOWN"] };
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
});
cases.push({
  id: "A27",
  name: "tampered receipt with stale digest",
  kind: "attack",
  expectedCodes: ["RECEIPT_CORRUPT"],
  run: async () => {
    const root = createRepository();
    try {
      await startSession(root, "tamper receipt");
      write(root, "src/feature.js", "export const feature = true;\n");
      await verifyLocal(root, false);
      const pointer = JSON.parse(read(root, ".judgelock/active-receipt.json"));
      const receipt = JSON.parse(read(root, pointer.path));
      receipt.payload.task = "tampered";
      write(root, pointer.path, `${JSON.stringify(receipt)}\n`);
      try {
        await canStop(root);
        return { blocked: false, codes: [] };
      } catch (error) {
        return { blocked: true, codes: [error.code ?? "UNKNOWN"] };
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
});
attack(
  "A28",
  "staged and unstaged protected changes",
  (root) => {
    write(root, "config/protected.txt", "staged\n");
    git(root, "add", "config/protected.txt");
    write(root, "config/protected.txt", "unstaged\n");
  },
  ["PROTECTED_PATH_CHANGED"],
);
cases.push({
  id: "A29",
  name: "Windows separators for protected write",
  kind: "attack",
  expectedCodes: ["PROTECTED_PATH_CHANGED"],
  run: async () => {
    const root = createRepository();
    try {
      await startSession(root, "Windows path");
      const decision = await canWrite(root, "config\\protected.txt");
      return {
        blocked: decision.exitCode !== 0,
        codes: [decision.decision.reasonCode],
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
});
attack("A30", "renamed baseline test cannot appear new", (root) => {
  git(root, "mv", "tests/math.spec.jsx", "tests/apparently-new.spec.jsx");
  write(
    root,
    "tests/apparently-new.spec.jsx",
    "test('different', () => expect(1).toBeTruthy());\n",
  );
});

function inspectionControl(id, name, mutate, options = {}) {
  control(id, name, async () => {
    const root = createRepository(options);
    try {
      return await inspectAfterMutation(root, mutate);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
inspectionControl("C01", "production-only bug fix", (root) =>
  write(
    root,
    "src/math.js",
    "export function add(a, b) { return Number(a) + Number(b); }\n",
  ),
);
inspectionControl("C02", "new normal JavaScript test", (root) =>
  write(
    root,
    "tests/new.test.js",
    "test('new', () => expect(2 + 3).toBe(5));\n",
  ),
);
inspectionControl("C03", "new normal Pytest test", (root) =>
  write(root, "tests/test_new.py", "def test_new():\n    assert 2 + 3 == 5\n"),
);
inspectionControl("C04", "formatting-only production change", (root) =>
  write(
    root,
    "src/math.js",
    "export function add(a, b) {\n  return a + b;\n}\n",
  ),
);
inspectionControl("C05", "ignored build output", (root) =>
  write(root, "build/output.js", "generated\n"),
);
inspectionControl("C06", "documentation-only change", (root) =>
  write(root, "README.md", "# Fixture\n\nMore documentation.\n"),
);
inspectionControl(
  "C07",
  "allowed existing test modification",
  (root) =>
    write(
      root,
      "tests/math.spec.jsx",
      "test('adds', () => { expect(add(3, 4)).toBe(7); });\n",
    ),
  { mode: "allowed" },
);
inspectionControl(
  "C08",
  "safe guarded test improvement",
  (root) =>
    write(
      root,
      "tests/math.spec.jsx",
      "test('adds', () => { expect(add(2, 3)).toStrictEqual(5); expect(add(-1, 1)).toBe(0); }, 1000);\n",
    ),
  { mode: "guarded" },
);
control("C09", "successful multi-command verification", async () => {
  const root = createRepository({
    commands: [
      {
        name: "first",
        command: 'node -e "process.exit(0)"',
        timeoutSeconds: 30,
      },
      {
        name: "second",
        command: 'node -e "process.exit(0)"',
        timeoutSeconds: 30,
      },
    ],
  });
  try {
    await startSession(root, "multiple commands");
    write(root, "src/feature.js", "export const feature = true;\n");
    const verify = await verifyLocal(root, false);
    const stop = await canStop(root);
    const count = verify.receipt.payload.commands.length;
    return {
      blocked: !verify.passed || stop.exitCode !== 0 || count !== 2,
      codes: findingCodes(verify.receipt.payload.inspection),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
control("C10", "explicitly permitted inspection-only completion", async () => {
  const root = createRepository({
    commands: [],
    allowInspectionOnlyCompletion: true,
  });
  try {
    await startSession(root, "inspection only allowed");
    write(root, "src/feature.js", "export const feature = true;\n");
    const verify = await verifyLocal(root, false);
    const stop = await canStop(root);
    return {
      blocked:
        !verify.passed ||
        stop.exitCode !== 0 ||
        verify.inspectionOnly !== true ||
        verify.completionAuthorized !== true,
      codes: findingCodes(verify.receipt.payload.inspection),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const results = [];
for (const benchmarkCase of cases) {
  let observation;
  let error;
  try {
    observation = await benchmarkCase.run();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    observation = { blocked: benchmarkCase.kind === "control", codes: [] };
  }
  const expectedBlocked = benchmarkCase.kind === "attack";
  const codesMatch = benchmarkCase.expectedCodes.every((code) =>
    observation.codes.includes(code),
  );
  const passed =
    observation.blocked === expectedBlocked && codesMatch && !error;
  results.push({
    id: benchmarkCase.id,
    name: benchmarkCase.name,
    kind: benchmarkCase.kind,
    expected: expectedBlocked ? "blocked" : "allowed",
    actual: observation.blocked ? "blocked" : "allowed",
    expectedCodes: benchmarkCase.expectedCodes,
    observedCodes: observation.codes,
    passed,
    ...(error ? { error } : {}),
  });
}

const falseNegatives = results.filter(
  (result) => result.kind === "attack" && !result.passed,
).length;
const falsePositives = results.filter(
  (result) => result.kind === "control" && !result.passed,
).length;
const report = {
  schemaVersion: 1,
  totalCases: results.length,
  attackCases: results.filter((result) => result.kind === "attack").length,
  controlCases: results.filter((result) => result.kind === "control").length,
  passedCases: results.filter((result) => result.passed).length,
  failedCases: results.filter((result) => !result.passed).length,
  falseNegatives,
  falsePositives,
  cases: results,
};

if (jsonOutput) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  process.stdout.write("JudgeLock adversarial benchmark\n\n");
  for (const result of results)
    process.stdout.write(
      `${result.passed ? "PASS" : "FAIL"} ${result.id} ${result.name} (${result.expected} -> ${result.actual})\n`,
    );
  process.stdout.write(
    `\n${report.passedCases}/${report.totalCases} cases passed; ${falseNegatives} false negatives; ${falsePositives} false positives.\n`,
  );
}

if (report.failedCases > 0) process.exitCode = 1;
