export const JUDGELOCK_VERSION = "0.1.0-beta.1";
export const CONFIG_FILE = "judgelock.yml";
export const STATE_DIRECTORY = ".judgelock";
export const SESSION_FILE = ".judgelock/session.json";
export const ACTIVE_RECEIPT_FILE = ".judgelock/active-receipt.json";

export const ExitCode = {
  OK: 0,
  INTERNAL_ERROR: 1,
  INVALID_INPUT_OR_CONFIG: 2,
  PRECONDITION_FAILED: 3,
  POLICY_VIOLATION: 4,
  VERIFICATION_FAILED: 5,
  COMPLETION_BLOCKED: 6,
  STATE_CORRUPT: 7,
  INTEGRATION_FAILED: 8,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
