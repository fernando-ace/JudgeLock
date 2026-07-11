import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/util/canonical-json";
import { digestPayload, hasValidDigest } from "../../src/util/hash";
import { BoundedCapture, redactText } from "../../src/verification/capture";

describe("canonical evidence helpers", () => {
  it("sorts object keys recursively without reordering arrays", () => {
    expect(canonicalJson({ z: 1, a: { d: 2, b: 1 }, list: [2, 1] })).toBe(
      '{"a":{"b":1,"d":2},"list":[2,1],"z":1}',
    );
  });

  it("detects payload tampering", () => {
    const envelope = digestPayload({ task: "safe", nested: { value: 1 } });
    expect(hasValidDigest(envelope)).toBe(true);
    envelope.payload.task = "changed";
    expect(hasValidDigest(envelope)).toBe(false);
  });
});

describe("bounded command capture", () => {
  it("redacts common secret forms", () => {
    expect(
      redactText("Authorization: Bearer abc.def.ghi\nTOKEN=super-secret-token"),
    ).not.toContain("abc.def.ghi");
    expect(redactText("github_pat_abcdefghijklmnopqrstuvwxyz123456")).toContain(
      "[REDACTED]",
    );
  });

  it("truncates retained output while hashing every raw byte", () => {
    const capture = new BoundedCapture(40);
    const raw = Buffer.from("start-" + "x".repeat(200) + "-end");
    capture.update(raw.subarray(0, 50));
    capture.update(raw.subarray(50));
    const result = capture.finish();
    expect(result.truncated).toBe(true);
    expect(result.retained).toContain("truncated output");
    expect(result.byteCount).toBe(raw.length);
    expect(result.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
  });
});
