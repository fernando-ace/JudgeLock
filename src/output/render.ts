import pc from "picocolors";
import type {
  Finding,
  InspectionResult,
  VerificationReceiptV1,
} from "../types";

const useColor =
  process.stdout.isTTY &&
  process.env.NO_COLOR === undefined &&
  pc.isColorSupported;
const color = (formatter: (value: string) => string, value: string): string =>
  useColor ? formatter(value) : value;

function renderFinding(finding: Finding): string {
  const heading =
    finding.severity === "blocking"
      ? color(pc.red, `BLOCKED  ${finding.code}`)
      : color(pc.yellow, `WARNING  ${finding.code}`);
  const location = `${finding.path}${finding.line === undefined ? "" : `:${String(finding.line)}${finding.column === undefined ? "" : `:${String(finding.column)}`}`}`;
  return `${heading}\n${location}\n\n${finding.explanation}\n\n${finding.remediation}`;
}

export function renderInspection(inspection: InspectionResult): string {
  const heading =
    inspection.status === "passed"
      ? color(pc.green, "PASS  JudgeLock inspection")
      : color(pc.red, "BLOCKED  JudgeLock inspection");
  const sections = [
    heading,
    `Baseline: ${inspection.baselineCommit}\nCurrent HEAD: ${inspection.currentHead}\nFingerprint: ${inspection.repositoryStateFingerprint}`,
  ];
  if (inspection.violations.length > 0)
    sections.push(inspection.violations.map(renderFinding).join("\n\n"));
  if (inspection.warnings.length > 0)
    sections.push(inspection.warnings.map(renderFinding).join("\n\n"));
  if (inspection.changedFiles.length === 0)
    sections.push("No relevant repository changes detected.");
  return `${sections.join("\n\n")}\n`;
}

export function renderVerification(
  receiptPath: string,
  receipt: VerificationReceiptV1,
): string {
  const payload = receipt.payload;
  const lines = [
    payload.finalStatus === "passed"
      ? color(pc.green, "PASS  JudgeLock verification")
      : payload.finalStatus === "inspection_only"
        ? color(pc.yellow, "INSPECTION ONLY  JudgeLock evidence")
        : color(pc.red, "FAILED  JudgeLock verification"),
    `Receipt: ${receiptPath}`,
    `Fingerprint: ${payload.repositoryStateFingerprint}`,
  ];
  if (payload.commands.length === 0) {
    lines.push(
      color(
        pc.yellow,
        "NO_VALIDATION_COMMANDS - no tests, lint checks, type checks, or builds were run.",
      ),
    );
  } else {
    for (const result of payload.commands) {
      const mark =
        result.status === "passed"
          ? color(pc.green, "PASS")
          : color(pc.red, result.status.toUpperCase());
      lines.push(
        `${mark}  ${result.name} (${String(Math.round(result.durationMs))} ms)`,
      );
      if (result.status !== "passed") {
        if (result.stdout.retained)
          lines.push(`stdout:\n${result.stdout.retained}`);
        if (result.stderr.retained)
          lines.push(`stderr:\n${result.stderr.retained}`);
      }
    }
  }
  if (payload.failureReason) lines.push(payload.failureReason);
  return `${lines.join("\n")}\n`;
}
