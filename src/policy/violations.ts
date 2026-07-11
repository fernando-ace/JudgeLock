import type {
  Finding,
  FindingCode,
  FindingConfidence,
  FindingSeverity,
} from "../types";
import { normalizeRepoPath } from "../util/paths";

export interface ViolationDefinition {
  severity: FindingSeverity;
  confidence: FindingConfidence;
  explanation: string;
  remediation: string;
}

export const VIOLATION_REGISTRY = {
  CONFIG_CHANGED: {
    severity: "blocking",
    confidence: "high",
    explanation:
      "The JudgeLock policy changed after the trusted baseline was established.",
    remediation:
      "Restore judgelock.yml or change policy in a separately reviewed trusted-base commit.",
  },
  EXISTING_TEST_MODIFIED: {
    severity: "blocking",
    confidence: "high",
    explanation:
      "A test that existed at the baseline was modified while existing tests are immutable.",
    remediation:
      "Restore the baseline test and add a new regression test instead.",
  },
  TEST_RENAMED: {
    severity: "blocking",
    confidence: "high",
    explanation: "A baseline test file was renamed.",
    remediation:
      "Restore the original test path and add new tests without moving baseline tests.",
  },
  TEST_DELETED: {
    severity: "blocking",
    confidence: "high",
    explanation: "A test that existed at the baseline was deleted.",
    remediation: "Restore the deleted test file or test case.",
  },
  NEW_TEST_NOT_ALLOWED: {
    severity: "blocking",
    confidence: "high",
    explanation:
      "A new test file was added while the policy disallows new tests.",
    remediation:
      "Remove the new test or have the trusted policy changed through review.",
  },
  SNAPSHOT_CHANGED: {
    severity: "blocking",
    confidence: "high",
    explanation: "A protected snapshot was added, changed, moved, or deleted.",
    remediation:
      "Restore the baseline snapshot and verify behavior with an ordinary regression test.",
  },
  SKIPPED_TEST_ADDED: {
    severity: "blocking",
    confidence: "high",
    explanation:
      "A new test skip, todo, pending, xfail, or disabled-test marker was introduced.",
    remediation: "Remove the skip marker and make the test pass.",
  },
  FOCUSED_TEST_ADDED: {
    severity: "blocking",
    confidence: "high",
    explanation: "A focused or exclusive test marker was introduced.",
    remediation: "Remove the focus marker so the complete test suite runs.",
  },
  TEST_CASE_REMOVED: {
    severity: "blocking",
    confidence: "high",
    explanation: "A baseline test case is no longer present.",
    remediation: "Restore the removed test case.",
  },
  ASSERTION_REMOVED: {
    severity: "blocking",
    confidence: "high",
    explanation:
      "A baseline test has fewer assertions or no longer checks an expected failure.",
    remediation:
      "Restore the removed assertion or add an equally strong check.",
  },
  ASSERTION_WEAKENED: {
    severity: "blocking",
    confidence: "high",
    explanation:
      "A baseline assertion was replaced with a less strict assertion.",
    remediation:
      "Use the original assertion strength or a demonstrably stronger assertion.",
  },
  ASSERTION_MISSING: {
    severity: "blocking",
    confidence: "high",
    explanation: "A test case has an empty body and cannot verify behavior.",
    remediation: "Add a meaningful assertion or remove the empty test case.",
  },
  TIMEOUT_INCREASED: {
    severity: "blocking",
    confidence: "high",
    explanation: "A literal test timeout was increased.",
    remediation:
      "Restore the original timeout and fix the underlying performance or synchronization problem.",
  },
  COVERAGE_THRESHOLD_REDUCED: {
    severity: "blocking",
    confidence: "high",
    explanation: "A coverage threshold was lowered or removed.",
    remediation:
      "Restore the baseline coverage threshold and add tests for uncovered behavior.",
  },
  COVERAGE_EXCLUSION_ADDED: {
    severity: "blocking",
    confidence: "high",
    explanation: "A new coverage exclusion or ignore directive was introduced.",
    remediation: "Remove the exclusion and cover the code with tests.",
  },
  TEST_DISCOVERY_NARROWED: {
    severity: "blocking",
    confidence: "high",
    explanation: "Test discovery was narrowed so fewer tests may run.",
    remediation:
      "Restore the baseline discovery settings and run the complete suite.",
  },
  VALIDATION_SCRIPT_CHANGED: {
    severity: "blocking",
    confidence: "high",
    explanation: "A protected validation script changed after the baseline.",
    remediation:
      "Restore the trusted validation script or update it in a separately reviewed baseline commit.",
  },
  PROTECTED_PATH_CHANGED: {
    severity: "blocking",
    confidence: "high",
    explanation: "A path protected by JudgeLock policy changed.",
    remediation:
      "Restore the protected path or change it outside the active task under review.",
  },
  INTEGRATION_CONFIG_CHANGED: {
    severity: "blocking",
    confidence: "high",
    explanation:
      "JudgeLock integration configuration changed during an active task.",
    remediation: "Restore the installed JudgeLock integration files.",
  },
  TEST_ANALYSIS_FAILED: {
    severity: "blocking",
    confidence: "high",
    explanation: "JudgeLock could not safely analyze a guarded test change.",
    remediation:
      "Fix the syntax or use test constructs JudgeLock can analyze before retrying.",
  },
  ANALYSIS_INCONCLUSIVE: {
    severity: "warning",
    confidence: "medium",
    explanation:
      "JudgeLock could not conclusively analyze a dynamic configuration change.",
    remediation:
      "Review the configuration change manually and prefer static literal configuration.",
  },
  UNMERGED_PATH: {
    severity: "blocking",
    confidence: "high",
    explanation: "The repository contains an unmerged path.",
    remediation:
      "Resolve the merge conflict and stage the resolved file before verification.",
  },
} as const satisfies Record<FindingCode, ViolationDefinition>;

export const violationRegistry: Readonly<
  Record<FindingCode, ViolationDefinition>
> = VIOLATION_REGISTRY;

export interface FindingOverrides {
  severity?: FindingSeverity;
  confidence?: FindingConfidence;
  line?: number;
  column?: number;
  explanation?: string;
  remediation?: string;
}

export function createFinding(
  code: FindingCode,
  path: string,
  overrides: FindingOverrides = {},
): Finding {
  const definition = VIOLATION_REGISTRY[code];
  return {
    code,
    path: normalizeRepoPath(path),
    severity: overrides.severity ?? definition.severity,
    confidence: overrides.confidence ?? definition.confidence,
    explanation: overrides.explanation ?? definition.explanation,
    remediation: overrides.remediation ?? definition.remediation,
    ...(overrides.line === undefined ? {} : { line: overrides.line }),
    ...(overrides.column === undefined ? {} : { column: overrides.column }),
  };
}

export const makeFinding = createFinding;

export function getViolationDefinition(code: FindingCode): ViolationDefinition {
  return VIOLATION_REGISTRY[code];
}
