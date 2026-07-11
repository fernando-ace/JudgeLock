import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runVerificationCommand } from "../../src/verification/runner";

describe("verification command runner", () => {
  it("times out commands with a stable result", async () => {
    const result = await runVerificationCommand({
      command: {
        name: "hang",
        command: 'node -e "setTimeout(() => {}, 5000)"',
        timeoutSeconds: 1,
      },
      cwd: process.cwd(),
      retainCharacters: 100,
    });
    expect(result.status).toBe("timed-out");
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeLessThan(4_000);
  });

  it("hashes complete large output while retaining a bounded sample", async () => {
    const result = await runVerificationCommand({
      command: {
        name: "large",
        command: "node -e \"process.stdout.write('x'.repeat(20000))\"",
        timeoutSeconds: 10,
      },
      cwd: process.cwd(),
      retainCharacters: 100,
    });
    expect(result.status).toBe("passed");
    expect(result.stdout.truncated).toBe(true);
    expect(result.stdout.retained.length).toBeLessThan(200);
    expect(result.stdout.sha256).toBe(
      createHash("sha256").update("x".repeat(20_000)).digest("hex"),
    );
  });
});
