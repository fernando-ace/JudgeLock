import { createHash } from "node:crypto";
import stripAnsi from "strip-ansi";
import type { CapturedOutput } from "../types";

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,})\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']?[^\s"']{6,}["']?/giu,
  /(?:https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,
];

export function redactText(input: string): string {
  let value = "";
  for (const character of stripAnsi(input)) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || code >= 32)
      value += character;
  }
  for (const pattern of SECRET_PATTERNS)
    value = value.replace(pattern, "[REDACTED]");
  return value;
}

export class BoundedCapture {
  readonly #hash = createHash("sha256");
  readonly #byteLimit: number;
  readonly #characterLimit: number;
  #byteCount = 0;
  #head = Buffer.alloc(0);
  #tail = Buffer.alloc(0);

  constructor(characterLimit: number) {
    this.#characterLimit = characterLimit;
    this.#byteLimit = Math.max(characterLimit * 4, 1);
  }

  update(chunk: string | Uint8Array): void {
    const buffer =
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    this.#hash.update(buffer);
    this.#byteCount += buffer.byteLength;
    if (this.#head.byteLength < this.#byteLimit) {
      const remaining = this.#byteLimit - this.#head.byteLength;
      this.#head = Buffer.concat([this.#head, buffer.subarray(0, remaining)]);
    }
    this.#tail = Buffer.concat([this.#tail, buffer]);
    if (this.#tail.byteLength > this.#byteLimit)
      this.#tail = this.#tail.subarray(this.#tail.byteLength - this.#byteLimit);
  }

  finish(): CapturedOutput {
    const hash = this.#hash.digest("hex");
    if (this.#characterLimit === 0) {
      return {
        sha256: hash,
        retained: "",
        byteCount: this.#byteCount,
        truncated: this.#byteCount > 0,
      };
    }
    const rawFits = this.#byteCount <= this.#head.byteLength;
    const combined = rawFits
      ? this.#head.toString("utf8")
      : `${this.#head.toString("utf8")}\n... JudgeLock truncated output ...\n${this.#tail.toString("utf8")}`;
    const sanitized = redactText(combined);
    if (sanitized.length <= this.#characterLimit) {
      return {
        sha256: hash,
        retained: sanitized,
        byteCount: this.#byteCount,
        truncated: !rawFits,
      };
    }
    const half = Math.floor(this.#characterLimit / 2);
    return {
      sha256: hash,
      retained: `${sanitized.slice(0, half)}\n... JudgeLock truncated output ...\n${sanitized.slice(-half)}`,
      byteCount: this.#byteCount,
      truncated: true,
    };
  }
}
