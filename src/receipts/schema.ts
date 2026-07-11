import { z } from "zod";

const findingSchema = z
  .object({
    severity: z.enum(["blocking", "warning"]),
    code: z.string(),
    path: z.string(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    explanation: z.string(),
    remediation: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();

const changedFileSchema = z
  .object({
    kind: z.enum(["added", "modified", "deleted", "renamed", "type-changed"]),
    path: z.string(),
    oldPath: z.string().optional(),
    layers: z.array(z.enum(["committed", "staged", "unstaged", "untracked"])),
  })
  .strict();

const inspectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["passed", "blocked"]),
    baselineCommit: z.string(),
    currentHead: z.string(),
    trustedPolicyHash: z.string(),
    repositoryStateFingerprint: z.string(),
    changedFiles: z.array(changedFileSchema),
    violations: z.array(findingSchema),
    warnings: z.array(findingSchema),
  })
  .strict();

const outputSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    retained: z.string(),
    byteCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

const commandSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    commandHash: z.string().regex(/^[a-f0-9]{64}$/u),
    startedAt: z.iso.datetime({ offset: true }),
    finishedAt: z.iso.datetime({ offset: true }),
    durationMs: z.number().nonnegative(),
    timeoutSeconds: z.number().int().positive(),
    status: z.enum(["passed", "failed", "timed-out", "spawn-error"]),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: outputSchema,
    stderr: outputSchema,
  })
  .strict();

export const ReceiptPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    judgeLockVersion: z.string(),
    mode: z.enum(["local", "ci"]),
    sessionId: z.uuid().optional(),
    task: z.string().optional(),
    repositoryId: z.string().regex(/^[a-f0-9]{64}$/u),
    baselineCommit: z.string(),
    policySourceCommit: z.string(),
    currentHead: z.string(),
    trustedPolicyHash: z.string().regex(/^[a-f0-9]{64}$/u),
    repositoryStateFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    changedFiles: z.array(changedFileSchema),
    inspection: inspectionSchema,
    commands: z.array(commandSchema),
    startedAt: z.iso.datetime({ offset: true }),
    finishedAt: z.iso.datetime({ offset: true }),
    durationMs: z.number().nonnegative(),
    runtime: z
      .object({
        nodeVersion: z.string(),
        platform: z.string(),
        arch: z.string(),
      })
      .strict(),
    finalStatus: z.enum(["passed", "failed"]),
    failureReason: z.string().optional(),
  })
  .strict();

export const VerificationReceiptSchema = z
  .object({
    payload: ReceiptPayloadSchema,
    digest: z
      .object({
        algorithm: z.literal("sha256"),
        value: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
  })
  .strict();
