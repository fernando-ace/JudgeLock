import { z } from "zod";

const digestSchema = z
  .object({
    algorithm: z.literal("sha256"),
    value: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const SessionPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.uuid(),
    task: z.string().trim().min(1).max(10_000),
    createdAt: z.iso.datetime({ offset: true }),
    repositoryId: z.string().regex(/^[a-f0-9]{64}$/u),
    baselineCommit: z.string().min(7),
    policySourceCommit: z.string().min(7),
    policyPath: z.literal("judgelock.yml"),
    trustedPolicyHash: z.string().regex(/^[a-f0-9]{64}$/u),
    judgeLockVersion: z.string().min(1),
  })
  .strict();

export const SessionFileSchema = z
  .object({ payload: SessionPayloadSchema, digest: digestSchema })
  .strict();

export const ActiveReceiptPointerSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.uuid(),
    path: z.string().min(1),
    receiptDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
