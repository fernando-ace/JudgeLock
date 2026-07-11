import { TextDecoder } from "node:util";
import type {
  AnalysisContext,
  ChangedFile,
  Finding,
  FindingCode,
  FindingConfidence,
} from "../types";
import { createFinding } from "../policy/violations";
import {
  isProtectedPath,
  isSnapshotPath,
  isTestPath,
  normalizeRepoPath,
} from "../util/paths";
import {
  analyzeConfigurationChange,
  findNewCoverageDirectives,
  isAnalyzedConfigPath,
} from "./configuration";
import { analyzeJavaScript } from "./javascript";
import type {
  AssertionObservation,
  MarkerObservation,
  TestFileAnalysis,
  TestObservation,
  TimeoutObservation,
} from "./model";
import { SourceAnalysisError } from "./model";
import { analyzePython } from "./python";

const JAVASCRIPT_TEST = /\.[cm]?[jt]sx?$/iu;
const PYTHON_TEST = /\.py$/iu;
const INTEGRATION_PATHS = new Set([
  ".claude/settings.json",
  ".claude/hooks/judgelock.cjs",
]);
const decoder = new TextDecoder("utf-8", { fatal: true });

function source(buffer: Buffer | undefined): string | null {
  if (!buffer) return null;
  return decoder.decode(buffer);
}

function countByKey<T extends { key: string }>(items: T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const values = result.get(item.key) ?? [];
    values.push(item);
    result.set(item.key, values);
  }
  return result;
}

function additions<T extends MarkerObservation>(before: T[], after: T[]): T[] {
  const baseline = countByKey(before);
  const seen = new Map<string, number>();
  return after.filter((item) => {
    const count = (seen.get(item.key) ?? 0) + 1;
    seen.set(item.key, count);
    return count > (baseline.get(item.key)?.length ?? 0);
  });
}

function timeoutIncreases(
  before: TimeoutObservation[],
  after: TimeoutObservation[],
): TimeoutObservation[] {
  const baseline = countByKey(before);
  const positions = new Map<string, number>();
  const increases: TimeoutObservation[] = [];
  for (const timeout of after) {
    const position = positions.get(timeout.key) ?? 0;
    positions.set(timeout.key, position + 1);
    const old = baseline.get(timeout.key)?.[position];
    if (old && timeout.milliseconds > old.milliseconds) increases.push(timeout);
  }
  return increases;
}

function expectedFailureCount(assertions: AssertionObservation[]): number {
  return assertions.filter((assertion) => assertion.expectedFailure).length;
}

function assertionFindings(
  path: string,
  before: TestObservation,
  after: TestObservation,
  context: AnalysisContext,
): Finding[] {
  const findings: Finding[] = [];
  if (context.config.testIntegrity.blockAssertionRemoval) {
    if (
      after.assertions.length < before.assertions.length ||
      expectedFailureCount(after.assertions) <
        expectedFailureCount(before.assertions)
    ) {
      findings.push(
        createFinding("ASSERTION_REMOVED", path, {
          line: after.line,
          column: after.column,
          explanation: `Test '${after.title}' has fewer assertions or expected-failure checks than at the baseline.`,
        }),
      );
    }
  }
  if (context.config.testIntegrity.blockAssertionWeakening) {
    const count = Math.min(before.assertions.length, after.assertions.length);
    for (let index = 0; index < count; index += 1) {
      const oldAssertion = before.assertions[index];
      const newAssertion = after.assertions[index];
      if (
        !oldAssertion ||
        !newAssertion ||
        newAssertion.strength >= oldAssertion.strength
      )
        continue;
      findings.push(
        createFinding("ASSERTION_WEAKENED", path, {
          line: newAssertion.line,
          column: newAssertion.column,
          explanation: `Test '${after.title}' weakened '${oldAssertion.matcher}' to '${newAssertion.matcher}'.`,
        }),
      );
    }
  }
  if (after.empty && !before.empty) {
    findings.push(
      createFinding("ASSERTION_MISSING", path, {
        line: after.line,
        column: after.column,
        explanation: `Test '${after.title}' now has an empty body.`,
      }),
    );
  }
  return findings;
}

function semanticFindings(
  path: string,
  before: TestFileAnalysis | null,
  after: TestFileAnalysis | null,
  context: AnalysisContext,
  options: {
    compareAssertions: boolean;
    compareCases: boolean;
    checkEmptyNewTests: boolean;
  },
): Finding[] {
  const findings: Finding[] = [];
  if (!after) return findings;
  const baseline: TestFileAnalysis = before ?? {
    tests: [],
    skipped: [],
    focused: [],
    timeouts: [],
    inconclusive: [],
  };

  if (context.config.testIntegrity.blockSkippedTests) {
    for (const marker of additions(baseline.skipped, after.skipped)) {
      findings.push(
        createFinding("SKIPPED_TEST_ADDED", path, {
          line: marker.line,
          column: marker.column,
        }),
      );
    }
  }
  if (context.config.testIntegrity.blockFocusedTests) {
    for (const marker of additions(baseline.focused, after.focused)) {
      findings.push(
        createFinding("FOCUSED_TEST_ADDED", path, {
          line: marker.line,
          column: marker.column,
        }),
      );
    }
  }
  if (context.config.testIntegrity.blockTimeoutIncreases) {
    for (const timeout of timeoutIncreases(baseline.timeouts, after.timeouts)) {
      findings.push(
        createFinding("TIMEOUT_INCREASED", path, {
          line: timeout.line,
          column: timeout.column,
          explanation: `Test timeout '${timeout.key}' increased to ${String(timeout.milliseconds)}ms.`,
        }),
      );
    }
  }

  const beforeTests = countByKey(baseline.tests);
  const afterTests = countByKey(after.tests);
  if (options.compareCases && context.config.testIntegrity.blockDeletedTests) {
    for (const [key, oldTests] of beforeTests) {
      const newTests = afterTests.get(key) ?? [];
      for (let index = newTests.length; index < oldTests.length; index += 1) {
        const oldTest = oldTests[index];
        if (!oldTest) continue;
        findings.push(
          createFinding("TEST_CASE_REMOVED", path, {
            line: oldTest.line,
            column: oldTest.column,
            explanation: `Baseline test case '${oldTest.title}' was removed.`,
          }),
        );
      }
    }
  }
  for (const [key, newTests] of afterTests) {
    const oldTests = beforeTests.get(key) ?? [];
    for (let index = 0; index < newTests.length; index += 1) {
      const newTest = newTests[index];
      if (!newTest) continue;
      const oldTest = oldTests[index];
      if (oldTest && options.compareAssertions)
        findings.push(...assertionFindings(path, oldTest, newTest, context));
      if (!oldTest && options.checkEmptyNewTests && newTest.empty) {
        findings.push(
          createFinding("ASSERTION_MISSING", path, {
            line: newTest.line,
            column: newTest.column,
            explanation: `New test '${newTest.title}' has an empty body.`,
          }),
        );
      }
    }
  }
  return findings;
}

function analyzeTestSource(path: string, text: string): TestFileAnalysis {
  if (JAVASCRIPT_TEST.test(path)) return analyzeJavaScript(path, text);
  if (PYTHON_TEST.test(path)) return analyzePython(text);
  throw new SourceAnalysisError(
    `The test language for '${path}' is not supported.`,
  );
}

function analysisFailure(
  path: string,
  error: unknown,
  blocking: boolean,
): Finding {
  const sourceError =
    error instanceof SourceAnalysisError
      ? error
      : new SourceAnalysisError(String(error));
  const code: FindingCode = blocking
    ? "TEST_ANALYSIS_FAILED"
    : "ANALYSIS_INCONCLUSIVE";
  const confidence: FindingConfidence = blocking ? "high" : "medium";
  return createFinding(code, path, {
    confidence,
    ...(sourceError.line === undefined ? {} : { line: sourceError.line }),
    ...(sourceError.column === undefined ? {} : { column: sourceError.column }),
    explanation: `${blocking ? "Guarded test analysis failed" : "Test analysis was inconclusive"}: ${sourceError.message}`,
  });
}

function baselinePath(change: ChangedFile): string {
  return change.oldPath ?? change.path;
}

function commonPathFindings(
  change: ChangedFile,
  context: AnalysisContext,
): Finding[] {
  const findings: Finding[] = [];
  const paths = [
    change.path,
    ...(change.oldPath === undefined ? [] : [change.oldPath]),
  ];
  if (
    paths.includes("judgelock.yml") &&
    (context.mode !== "ci" || !context.config.ci.allowPolicyChanges)
  ) {
    findings.push(createFinding("CONFIG_CHANGED", "judgelock.yml"));
  }
  if (paths.some((path) => INTEGRATION_PATHS.has(path))) {
    findings.push(createFinding("INTEGRATION_CONFIG_CHANGED", change.path));
  }
  if (paths.some((path) => isProtectedPath(path, context.config))) {
    findings.push(createFinding("PROTECTED_PATH_CHANGED", change.path));
  }
  if (
    context.config.testIntegrity.blockSnapshotChanges &&
    paths.some((path) => isSnapshotPath(path, context.config))
  ) {
    findings.push(createFinding("SNAPSHOT_CHANGED", change.path));
  }
  return findings;
}

function testChangeFindings(
  change: ChangedFile,
  context: AnalysisContext,
): Finding[] {
  const oldPath = baselinePath(change);
  const path = change.path;
  const baselineWasTest =
    context.state.baselineFiles.has(oldPath) &&
    isTestPath(oldPath, context.config);
  const currentIsTest =
    change.kind !== "deleted" && isTestPath(path, context.config);
  if (!baselineWasTest && !currentIsTest) return [];

  const mode = context.config.testIntegrity.existingTests;
  const structuralFindings: Finding[] = [];
  if (change.kind === "renamed" && baselineWasTest)
    return [createFinding("TEST_RENAMED", path)];
  if (change.kind === "deleted" && baselineWasTest) {
    if (
      mode === "immutable" ||
      context.config.testIntegrity.blockDeletedTests
    ) {
      return [createFinding("TEST_DELETED", oldPath)];
    }
    return [];
  }
  if (
    !baselineWasTest &&
    currentIsTest &&
    !context.config.testIntegrity.allowNewTests
  ) {
    structuralFindings.push(createFinding("NEW_TEST_NOT_ALLOWED", path));
  }
  if (baselineWasTest && mode === "immutable") {
    structuralFindings.push(createFinding("EXISTING_TEST_MODIFIED", path));
  }

  let oldSource: string | null;
  let currentSource: string | null;
  try {
    oldSource = source(context.state.baselineContent.get(oldPath));
    currentSource = source(context.state.currentContent.get(path));
  } catch (error) {
    return [
      ...structuralFindings,
      analysisFailure(path, error, baselineWasTest && mode === "guarded"),
    ];
  }
  if (currentSource === null) return structuralFindings;

  try {
    const currentAnalysis = analyzeTestSource(path, currentSource);
    let baselineAnalysis: TestFileAnalysis | null = null;
    if (baselineWasTest && oldSource !== null)
      baselineAnalysis = analyzeTestSource(oldPath, oldSource);
    const findings = semanticFindings(
      path,
      baselineAnalysis,
      currentAnalysis,
      context,
      {
        compareAssertions: baselineWasTest && mode === "guarded",
        compareCases: baselineWasTest && mode !== "immutable",
        checkEmptyNewTests: !baselineWasTest,
      },
    );
    const uncertainty = [
      ...(baselineAnalysis?.inconclusive ?? []),
      ...currentAnalysis.inconclusive,
    ];
    if (uncertainty.length > 0) {
      const blocking = baselineWasTest && mode === "guarded";
      findings.push(
        createFinding(
          blocking ? "TEST_ANALYSIS_FAILED" : "ANALYSIS_INCONCLUSIVE",
          path,
          {
            confidence: blocking ? "high" : "medium",
            explanation: `${blocking ? "Guarded test analysis failed" : "Test analysis was inconclusive"}: ${[...new Set(uncertainty)].join("; ")}.`,
          },
        ),
      );
    }
    return [...structuralFindings, ...findings];
  } catch (error) {
    return [
      ...structuralFindings,
      analysisFailure(path, error, baselineWasTest && mode === "guarded"),
    ];
  }
}

function contentFindings(
  change: ChangedFile,
  context: AnalysisContext,
): Finding[] {
  const path = change.path;
  const oldPath = baselinePath(change);
  let oldSource: string | null;
  let currentSource: string | null;
  try {
    oldSource = source(context.state.baselineContent.get(oldPath));
    currentSource = source(context.state.currentContent.get(path));
  } catch {
    return [];
  }
  const findings: Finding[] = [];
  if (context.config.coverage.blockNewExclusions) {
    findings.push(...findNewCoverageDirectives(path, oldSource, currentSource));
  }
  if (isAnalyzedConfigPath(path) || isAnalyzedConfigPath(oldPath)) {
    findings.push(
      ...analyzeConfigurationChange(
        path,
        oldSource,
        currentSource,
        context.config,
      ),
    );
  }
  return findings;
}

function deduplicateAndSort(findings: Finding[]): Finding[] {
  const unique = new Map<string, Finding>();
  for (const finding of findings) {
    const key = [
      finding.code,
      finding.path,
      finding.line ?? "",
      finding.column ?? "",
      finding.explanation,
    ].join("\0");
    unique.set(key, finding);
  }
  return [...unique.values()].sort((left, right) => {
    if (left.severity !== right.severity)
      return left.severity === "blocking" ? -1 : 1;
    const pathOrder = left.path.localeCompare(right.path);
    if (pathOrder !== 0) return pathOrder;
    const lineOrder = (left.line ?? 0) - (right.line ?? 0);
    if (lineOrder !== 0) return lineOrder;
    return left.code.localeCompare(right.code);
  });
}

export function analyzeRepository(
  context: AnalysisContext,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const path of context.state.unmergedPaths) {
    findings.push(createFinding("UNMERGED_PATH", normalizeRepoPath(path)));
  }
  for (const change of context.state.changedFiles) {
    findings.push(...commonPathFindings(change, context));
    findings.push(...testChangeFindings(change, context));
    findings.push(...contentFindings(change, context));
  }
  return Promise.resolve(deduplicateAndSort(findings));
}

export { analyzeJavaScript } from "./javascript";
export { analyzePython } from "./python";
