import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canStop } from "../../src/commands/hooks";
import { startSession } from "../../src/commands/start";
import { getStatus } from "../../src/commands/status";
import { ExitCode } from "../../src/constants";
import type { ReceiptPayloadV1 } from "../../src/types";
import { digestPayload } from "../../src/util/hash";
import { verifyCi, verifyLocal } from "../../src/verification/verify";
import { TestRepository } from "../helpers/git-repo";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repo) => repo.cleanup()));
});

async function repo(
  options: Parameters<typeof TestRepository.create>[0] = {},
): Promise<TestRepository> {
  const value = await TestRepository.create(options);
  repositories.push(value);
  return value;
}

describe("inspection-only completion policy", () => {
  it("records current evidence but blocks completion by default", async () => {
    const directory = await repo();
    await startSession(directory.path, "Inspect only");

    const verification = await verifyLocal(directory.path, false);
    expect(verification).toMatchObject({
      passed: true,
      evidenceValid: true,
      inspectionOnly: true,
      completionAuthorized: false,
      receipt: { payload: { finalStatus: "inspection_only", commands: [] } },
    });
    await expect(canStop(directory.path)).resolves.toMatchObject({
      exitCode: ExitCode.COMPLETION_BLOCKED,
      decision: { reasonCode: "COMPLETION_BLOCKED" },
    });
    const status = await getStatus(directory.path);
    expect(status).toMatchObject({
      evidenceValid: true,
      inspectionOnly: true,
      completionAuthorized: false,
    });
    expect(status.warning).toContain(
      "No tests, lint checks, type checks, or builds were run",
    );
  });

  it("allows inspection-only completion only through trusted opt-in", async () => {
    const directory = await repo({ allowInspectionOnlyCompletion: true });
    await startSession(directory.path, "Permitted inspection only");

    const verification = await verifyLocal(directory.path, false);
    expect(verification).toMatchObject({
      inspectionOnly: true,
      completionAuthorized: true,
    });
    await expect(canStop(directory.path)).resolves.toMatchObject({
      exitCode: ExitCode.OK,
      decision: { reasonCode: "COMPLETION_ALLOWED" },
    });
  });

  it("fails CI completion unless the trusted base opts in", async () => {
    const blocked = await repo();
    await blocked.git(["checkout", "-b", "feature"]);
    await blocked.write("src/feature.js", "export const feature = true;\n");
    await blocked.commit("feature");
    await expect(verifyCi(blocked.path, "main")).resolves.toMatchObject({
      passed: false,
      evidenceValid: true,
      inspectionOnly: true,
      completionAuthorized: false,
      failureKind: "inspection-only",
    });

    const allowed = await repo({ allowInspectionOnlyCompletion: true });
    await allowed.git(["checkout", "-b", "feature"]);
    await allowed.write("src/feature.js", "export const feature = true;\n");
    await allowed.commit("feature");
    await expect(verifyCi(allowed.path, "main")).resolves.toMatchObject({
      passed: true,
      evidenceValid: true,
      inspectionOnly: true,
      completionAuthorized: true,
    });
  });

  it("rejects a legacy zero-command receipt mislabeled as passed", async () => {
    const directory = await repo();
    const session = await startSession(directory.path, "Legacy receipt");
    const verification = await verifyLocal(directory.path, false);
    const receiptPath = join(directory.path, verification.receiptPath);
    const legacyPayload: ReceiptPayloadV1 = {
      ...verification.receipt.payload,
      finalStatus: "passed",
    };
    const legacyReceipt = digestPayload(legacyPayload);
    await writeFile(receiptPath, `${JSON.stringify(legacyReceipt)}\n`);
    const pointerPath = join(
      directory.path,
      ".judgelock",
      "active-receipt.json",
    );
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
      schemaVersion: 1;
      sessionId: string;
      path: string;
      receiptDigest: string;
    };
    await writeFile(
      pointerPath,
      `${JSON.stringify({
        ...pointer,
        sessionId: session.session.sessionId,
        receiptDigest: legacyReceipt.digest.value,
      })}\n`,
    );

    await expect(canStop(directory.path)).resolves.toMatchObject({
      exitCode: ExitCode.COMPLETION_BLOCKED,
    });
  });
});
