import { ExitCode, type ExitCodeValue } from "./constants";

export class JudgeLockError extends Error {
  readonly code: string;
  readonly exitCode: ExitCodeValue;
  readonly remediation: string | undefined;

  constructor(
    message: string,
    options: {
      code: string;
      exitCode?: ExitCodeValue;
      remediation?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "JudgeLockError";
    this.code = options.code;
    this.exitCode = options.exitCode ?? ExitCode.INTERNAL_ERROR;
    this.remediation = options.remediation;
  }
}

export function toJudgeLockError(error: unknown): JudgeLockError {
  if (error instanceof JudgeLockError) return error;
  return new JudgeLockError(
    error instanceof Error ? error.message : String(error),
    {
      code: "INTERNAL_ERROR",
      cause: error,
    },
  );
}
