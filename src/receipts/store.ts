import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ExitCode } from "../constants";
import type { JudgeLockConfig } from "../config/schema";
import { JudgeLockError } from "../errors";
import type { ReceiptPayloadV1, VerificationReceiptV1 } from "../types";
import { atomicWriteJson } from "../util/atomic";
import { digestPayload, hasValidDigest } from "../util/hash";
import { normalizeRepoPath } from "../util/paths";
import { isPathInside } from "../util/safe-path";
import { VerificationReceiptSchema } from "./schema";

function safeTimestamp(value: string): string {
  return value.replaceAll(":", "-");
}

export async function writeReceipt(options: {
  root: string;
  config: JudgeLockConfig;
  payload: ReceiptPayloadV1;
  attempt?: boolean;
}): Promise<{
  path: string;
  relativePath: string;
  receipt: VerificationReceiptV1;
}> {
  const directory = options.attempt
    ? resolve(options.root, ".judgelock", "attempts")
    : resolve(options.root, options.config.receipt.directory);
  if (!isPathInside(options.root, directory))
    throw new Error("Receipt directory escapes repository.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identity =
    options.payload.sessionId ??
    `ci-${options.payload.currentHead.slice(0, 12)}`;
  const suffix = options.payload.finalStatus === "passed" ? "passed" : "failed";
  const path = join(
    directory,
    `${identity}-${safeTimestamp(options.payload.finishedAt)}.${suffix}.json`,
  );
  const receipt = digestPayload(options.payload);
  await atomicWriteJson(path, receipt);
  return {
    path,
    relativePath: normalizeRepoPath(relative(options.root, path)),
    receipt,
  };
}

export async function loadReceipt(
  root: string,
  relativePath: string,
): Promise<VerificationReceiptV1> {
  const path = resolve(root, relativePath);
  if (!isPathInside(root, path)) {
    throw new JudgeLockError("Receipt path escapes the repository.", {
      code: "RECEIPT_PATH_INVALID",
      exitCode: ExitCode.STATE_CORRUPT,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new JudgeLockError(`Could not read receipt ${relativePath}.`, {
      code: "RECEIPT_UNREADABLE",
      exitCode: ExitCode.STATE_CORRUPT,
      cause: error,
    });
  }
  const parsed = VerificationReceiptSchema.safeParse(value);
  if (
    !parsed.success ||
    !hasValidDigest(parsed.data as VerificationReceiptV1)
  ) {
    throw new JudgeLockError(
      `Receipt ${relativePath} is invalid or its digest does not match.`,
      {
        code: "RECEIPT_CORRUPT",
        exitCode: ExitCode.STATE_CORRUPT,
      },
    );
  }
  return parsed.data as VerificationReceiptV1;
}
