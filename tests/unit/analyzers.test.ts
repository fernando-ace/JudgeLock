import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  analyzeJavaScript,
  analyzePython,
  analyzeRepository,
} from "../../src/analyzers/index";
import { DEFAULT_CONFIG } from "../../src/config/defaults";
import {
  JudgeLockConfigSchema,
  type JudgeLockConfig,
} from "../../src/config/schema";
import type { ChangedFile, RepositoryState } from "../../src/types";

function config(overrides: Partial<JudgeLockConfig> = {}): JudgeLockConfig {
  const base = JudgeLockConfigSchema.parse(parseYaml(DEFAULT_CONFIG));
  return JudgeLockConfigSchema.parse({
    ...base,
    ...overrides,
    testIntegrity: { ...base.testIntegrity, ...overrides.testIntegrity },
    coverage: { ...base.coverage, ...overrides.coverage },
    validation: { ...base.validation, ...overrides.validation },
    paths: { ...base.paths, ...overrides.paths },
    receipt: { ...base.receipt, ...overrides.receipt },
    ci: { ...base.ci, ...overrides.ci },
  });
}

function state(options: {
  change: ChangedFile;
  baseline?: string;
  current?: string;
  baselineExists?: boolean;
  unmergedPaths?: string[];
}): RepositoryState {
  const oldPath = options.change.oldPath ?? options.change.path;
  return {
    root: "/repo",
    baselineCommit: "a".repeat(40),
    currentHead: "a".repeat(40),
    policySourceCommit: "a".repeat(40),
    trustedPolicyHash: "policy",
    fingerprint: "fingerprint",
    manifest: {
      schemaVersion: 1,
      baselineCommit: "a".repeat(40),
      currentHead: "a".repeat(40),
      policySourceCommit: "a".repeat(40),
      trustedPolicyHash: "policy",
      entries: [],
    },
    changedFiles: [options.change],
    baselineFiles: new Set(options.baselineExists === false ? [] : [oldPath]),
    baselineContent: new Map(
      options.baseline === undefined
        ? []
        : [[oldPath, Buffer.from(options.baseline)]],
    ),
    currentContent: new Map(
      options.current === undefined
        ? []
        : [[options.change.path, Buffer.from(options.current)]],
    ),
    unmergedPaths: options.unmergedPaths ?? [],
  };
}

describe("language analyzers", () => {
  it("extracts JavaScript tests, assertions, focus, skips, and timeouts", () => {
    const result = analyzeJavaScript(
      "thing.test.ts",
      `
        describe.only("suite", () => {
          test.skip("disabled", () => {});
          test("exact", () => {
            expect({ value: 1 }).toStrictEqual({ value: 1 });
            expect(() => fail()).toThrow();
          }, 250);
        });
      `,
    );
    expect(result.tests.map((test) => test.title)).toEqual([
      "disabled",
      "exact",
    ]);
    expect(result.skipped).toHaveLength(1);
    expect(result.focused).toHaveLength(1);
    expect(
      result.tests[1]?.assertions.map((assertion) => assertion.matcher),
    ).toEqual(["toStrictEqual", "toThrow"]);
    expect(
      result.timeouts.some((timeout) => timeout.milliseconds === 250),
    ).toBe(true);
  });

  it("conservatively extracts Python skip, xfail, assertions, raises, and timeout markers", () => {
    const result = analyzePython(`
@pytest.mark.xfail(reason="known")
@pytest.mark.timeout(2)
def test_invoice():
    assert total == 10
    with pytest.raises(ValueError):
        invoice(-1)

def test_disabled():
    pytest.skip("later")
`);
    expect(result.tests.map((test) => test.title)).toEqual([
      "test_invoice",
      "test_disabled",
    ]);
    expect(result.skipped).toHaveLength(2);
    expect(
      result.tests[0]?.assertions.map((assertion) => assertion.matcher),
    ).toEqual(["assert", "pytest.raises"]);
    expect(result.timeouts[0]?.milliseconds).toBe(2000);
  });
});

describe("repository policy analysis", () => {
  const baselineTest = `
test("total", () => {
  expect(total).toStrictEqual(2);
  expect(() => explode()).toThrow();
}, 100);
test("kept", () => { expect(true).toBe(true); });
`;
  const weakenedTest = `
test.only("total", () => {
  expect(total).toEqual(2);
}, 200);
test.skip("replacement", () => { expect(true).toBe(true); });
`;

  it("blocks any baseline test edit in immutable mode", async () => {
    const findings = await analyzeRepository({
      config: config(),
      state: state({
        change: {
          kind: "modified",
          path: "src/invoice.test.ts",
          layers: ["unstaged"],
        },
        baseline: baselineTest,
        current: weakenedTest,
      }),
    });
    expect(new Set(findings.map((finding) => finding.code))).toEqual(
      new Set([
        "EXISTING_TEST_MODIFIED",
        "FOCUSED_TEST_ADDED",
        "SKIPPED_TEST_ADDED",
        "TIMEOUT_INCREASED",
      ]),
    );
  });

  it("reports high-confidence weakening in guarded mode", async () => {
    const findings = await analyzeRepository({
      config: config({
        testIntegrity: {
          existingTests: "guarded",
        } as JudgeLockConfig["testIntegrity"],
      }),
      state: state({
        change: {
          kind: "modified",
          path: "src/invoice.test.ts",
          layers: ["staged"],
        },
        baseline: baselineTest,
        current: weakenedTest,
      }),
    });
    expect(new Set(findings.map((finding) => finding.code))).toEqual(
      new Set([
        "ASSERTION_REMOVED",
        "ASSERTION_WEAKENED",
        "FOCUSED_TEST_ADDED",
        "SKIPPED_TEST_ADDED",
        "TEST_CASE_REMOVED",
        "TIMEOUT_INCREASED",
      ]),
    );
  });

  it("allows assertion deltas in allowed mode while retaining skip protection", async () => {
    const withoutSkip = weakenedTest
      .replace("test.skip", "test")
      .replace("test.only", "test");
    const findings = await analyzeRepository({
      config: config({
        testIntegrity: {
          existingTests: "allowed",
        } as JudgeLockConfig["testIntegrity"],
      }),
      state: state({
        change: {
          kind: "modified",
          path: "src/invoice.test.ts",
          layers: ["unstaged"],
        },
        baseline: baselineTest,
        current: withoutSkip.replace(", 200", ", 100"),
      }),
    });
    expect(findings.map((finding) => finding.code)).toEqual([
      "TEST_CASE_REMOVED",
    ]);
  });

  it("protects policy, integration, protected, snapshot, and unmerged paths", async () => {
    const policyFindings = await analyzeRepository({
      config: config({
        paths: {
          protectedPatterns: ["secrets/**"],
        } as JudgeLockConfig["paths"],
      }),
      state: {
        ...state({
          change: {
            kind: "modified",
            path: "judgelock.yml",
            layers: ["unstaged"],
          },
          baseline: "version: 1",
          current: "version: 2",
          unmergedPaths: ["src/conflict.ts"],
        }),
        changedFiles: [
          { kind: "modified", path: "judgelock.yml", layers: ["unstaged"] },
          {
            kind: "modified",
            path: ".claude/settings.json",
            layers: ["unstaged"],
          },
          { kind: "modified", path: "secrets/key.txt", layers: ["unstaged"] },
          {
            kind: "modified",
            path: "tests/__snapshots__/view.snap",
            layers: ["unstaged"],
          },
        ],
      },
    });
    expect(new Set(policyFindings.map((finding) => finding.code))).toEqual(
      new Set([
        "CONFIG_CHANGED",
        "INTEGRATION_CONFIG_CHANGED",
        "PROTECTED_PATH_CHANGED",
        "SNAPSHOT_CHANGED",
        "UNMERGED_PATH",
      ]),
    );
  });

  it("detects protected scripts, narrowed discovery, coverage reductions, and exclusions", async () => {
    const baseline = JSON.stringify({
      scripts: { test: "vitest run" },
      jest: {
        coverageThreshold: { global: { lines: 90 } },
        testMatch: ["**/*.test.js"],
      },
    });
    const current = JSON.stringify({
      scripts: { test: "vitest run tests/unit" },
      jest: {
        coverageThreshold: { global: { lines: 80 } },
        coveragePathIgnorePatterns: ["generated/"],
        testMatch: [],
      },
    });
    const findings = await analyzeRepository({
      config: config(),
      state: state({
        change: { kind: "modified", path: "package.json", layers: ["staged"] },
        baseline,
        current,
      }),
    });
    expect(new Set(findings.map((finding) => finding.code))).toEqual(
      new Set([
        "COVERAGE_EXCLUSION_ADDED",
        "COVERAGE_THRESHOLD_REDUCED",
        "TEST_DISCOVERY_NARROWED",
        "VALIDATION_SCRIPT_CHANGED",
      ]),
    );
  });
});
