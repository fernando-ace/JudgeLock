import type { JudgeLockConfig } from "../config/schema";
import type { GitClient } from "../git/client";
import { captureRepositoryState } from "../git/state";
import type { Finding, InspectionResult, RepositoryState } from "../types";
import { analyzeRepository } from "../analyzers/index";

function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort((left, right) => {
    const severity =
      left.severity === right.severity
        ? 0
        : left.severity === "blocking"
          ? -1
          : 1;
    if (severity !== 0) return severity;
    const path = left.path.localeCompare(right.path);
    if (path !== 0) return path;
    const line = (left.line ?? 0) - (right.line ?? 0);
    if (line !== 0) return line;
    return left.code.localeCompare(right.code);
  });
}

export async function inspectRepository(options: {
  git: GitClient;
  baselineCommit: string;
  policySourceCommit: string;
  trustedPolicyHash: string;
  config: JudgeLockConfig;
  mode: "local" | "ci";
}): Promise<{ inspection: InspectionResult; state: RepositoryState }> {
  const state = await captureRepositoryState(options);
  const findings = sortFindings(
    await analyzeRepository({
      config: options.config,
      state,
      mode: options.mode,
    }),
  );
  const violations = findings.filter(
    (finding) => finding.severity === "blocking",
  );
  const warnings = findings.filter((finding) => finding.severity === "warning");
  return {
    state,
    inspection: {
      schemaVersion: 1,
      status: violations.length === 0 ? "passed" : "blocked",
      baselineCommit: state.baselineCommit,
      currentHead: state.currentHead,
      trustedPolicyHash: state.trustedPolicyHash,
      repositoryStateFingerprint: state.fingerprint,
      changedFiles: state.changedFiles,
      violations,
      warnings,
    },
  };
}
