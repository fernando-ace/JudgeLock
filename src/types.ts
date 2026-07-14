import type { JudgeLockConfig } from "./config/schema";

export type { JudgeLockConfig } from "./config/schema";

export type ExistingTestMode = "immutable" | "guarded" | "allowed";
export type FindingSeverity = "blocking" | "warning";
export type FindingConfidence = "high" | "medium" | "low";
export type ChangeLayer = "committed" | "staged" | "unstaged" | "untracked";

export type FindingCode =
  | "CONFIG_CHANGED"
  | "EXISTING_TEST_MODIFIED"
  | "TEST_RENAMED"
  | "TEST_DELETED"
  | "NEW_TEST_NOT_ALLOWED"
  | "SNAPSHOT_CHANGED"
  | "SKIPPED_TEST_ADDED"
  | "FOCUSED_TEST_ADDED"
  | "TEST_CASE_REMOVED"
  | "ASSERTION_REMOVED"
  | "ASSERTION_WEAKENED"
  | "ASSERTION_MISSING"
  | "TIMEOUT_INCREASED"
  | "COVERAGE_THRESHOLD_REDUCED"
  | "COVERAGE_EXCLUSION_ADDED"
  | "TEST_DISCOVERY_NARROWED"
  | "VALIDATION_SCRIPT_CHANGED"
  | "PROTECTED_PATH_CHANGED"
  | "INTEGRATION_CONFIG_CHANGED"
  | "TEST_ANALYSIS_FAILED"
  | "ANALYSIS_INCONCLUSIVE"
  | "UNMERGED_PATH";

export interface Finding {
  severity: FindingSeverity;
  code: FindingCode;
  path: string;
  line?: number;
  column?: number;
  explanation: string;
  remediation: string;
  confidence: FindingConfidence;
}

export type ChangeKind =
  "added" | "modified" | "deleted" | "renamed" | "type-changed";

export interface ChangedFile {
  kind: ChangeKind;
  path: string;
  oldPath?: string;
  layers: ChangeLayer[];
}

export interface GitTreeEntry {
  mode: string;
  oid: string;
}

export interface WorktreeEntry {
  kind: "file" | "symlink";
  sha256: string;
  size: number;
  executable: boolean;
}

export interface FingerprintEntry {
  path: string;
  baseline: GitTreeEntry | null;
  head: GitTreeEntry | null;
  index: GitTreeEntry[];
  worktree: WorktreeEntry | null;
  layers: ChangeLayer[];
  renameFrom?: string;
}

export interface FingerprintManifestV1 {
  schemaVersion: 1;
  baselineCommit: string;
  currentHead: string;
  policySourceCommit: string;
  trustedPolicyHash: string;
  entries: FingerprintEntry[];
}

export interface RepositoryState {
  root: string;
  baselineCommit: string;
  currentHead: string;
  policySourceCommit: string;
  trustedPolicyHash: string;
  fingerprint: string;
  manifest: FingerprintManifestV1;
  changedFiles: ChangedFile[];
  baselineFiles: Set<string>;
  baselineContent: Map<string, Buffer>;
  currentContent: Map<string, Buffer>;
  unmergedPaths: string[];
}

export interface InspectionResult {
  schemaVersion: 1;
  status: "passed" | "blocked";
  baselineCommit: string;
  currentHead: string;
  trustedPolicyHash: string;
  repositoryStateFingerprint: string;
  changedFiles: ChangedFile[];
  violations: Finding[];
  warnings: Finding[];
}

export interface SessionPayloadV1 {
  schemaVersion: 1;
  sessionId: string;
  task: string;
  createdAt: string;
  repositoryId: string;
  baselineCommit: string;
  policySourceCommit: string;
  policyPath: "judgelock.yml";
  trustedPolicyHash: string;
  judgeLockVersion: string;
}

export interface DigestDescriptor {
  algorithm: "sha256";
  value: string;
}

export interface DigestedEnvelope<T> {
  payload: T;
  digest: DigestDescriptor;
}

export type SessionFileV1 = DigestedEnvelope<SessionPayloadV1>;

export interface CapturedOutput {
  sha256: string;
  retained: string;
  byteCount: number;
  truncated: boolean;
}

export type CommandStatus = "passed" | "failed" | "timed-out" | "spawn-error";

export interface CommandResult {
  name: string;
  command: string;
  commandHash: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timeoutSeconds: number;
  status: CommandStatus;
  exitCode: number | null;
  signal: string | null;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
}

export interface ReceiptPayloadV1 {
  schemaVersion: 1;
  judgeLockVersion: string;
  mode: "local" | "ci";
  sessionId?: string;
  task?: string;
  repositoryId: string;
  baselineCommit: string;
  policySourceCommit: string;
  currentHead: string;
  trustedPolicyHash: string;
  repositoryStateFingerprint: string;
  changedFiles: ChangedFile[];
  inspection: InspectionResult;
  commands: CommandResult[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  runtime: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  finalStatus: "passed" | "failed" | "inspection_only";
  failureReason?: string;
}

export type VerificationReceiptV1 = DigestedEnvelope<ReceiptPayloadV1>;
export type VerificationReceipt = VerificationReceiptV1;

export interface ActiveReceiptPointer {
  schemaVersion: 1;
  sessionId: string;
  path: string;
  receiptDigest: string;
}

export interface HookWriteDecision {
  schemaVersion: 1;
  decision: "allow" | "deny";
  reasonCode: string;
  path: string;
  explanation: string;
}

export interface HookStopDecision {
  schemaVersion: 1;
  decision: "allow" | "deny";
  reasonCode: string;
  explanation: string;
  receiptPath?: string;
}

export interface AnalysisContext {
  config: JudgeLockConfig;
  state: RepositoryState;
  mode?: "local" | "ci";
}

export type CommandEnvelope<T> =
  | { schemaVersion: 1; command: string; ok: true; exitCode: 0; result: T }
  | {
      schemaVersion: 1;
      command: string;
      ok: false;
      exitCode: number;
      error: { code: string; message: string; remediation?: string };
      result?: T;
    };
