# Hook contract

JudgeLock integrations call a small stable hook surface. The hook commands
provide early feedback and a final completion check without duplicating the
policy engine.

## Write decision

```sh
judgelock hook can-write --path path/to/file.ts
judgelock hook can-write --path path/to/file.ts --json
```

The path may be absolute or repository-relative as supplied by an integration.
JudgeLock resolves it against the Git root, rejects paths outside the repository
and symlink escapes, then returns a `HookWriteDecision`:

```json
{
  "schemaVersion": 1,
  "decision": "deny",
  "reasonCode": "EXISTING_TEST_MODIFIED",
  "path": "tests/invoice.test.ts",
  "explanation": "Existing baseline tests are immutable during this session."
}
```

When no JudgeLock session exists, the decision is allow. During an active
session, the fast check denies:

- corrupt state or unsafe paths;
- `judgelock.yml`, `.judgelock/` state, and JudgeLock-managed integration files;
- explicit protected paths;
- immutable baseline tests;
- snapshots when snapshot changes are blocked; and
- new tests when `allowNewTests` is false.

A guarded existing-test path can be written because path-only analysis cannot
determine whether its content became weaker. `judgelock inspect` remains
authoritative and fails closed if the guarded edit cannot be analyzed
confidently.

Allow exits 0. Denial exits 4; corrupt state exits 7. JSON output is one
complete document with no human text mixed into stdout.

## Stop decision

```sh
judgelock hook can-stop
judgelock hook can-stop --json
```

The result is a `HookStopDecision`:

```json
{
  "schemaVersion": 1,
  "decision": "allow",
  "reasonCode": "COMPLETION_ALLOWED",
  "explanation": "The active receipt matches the current repository state.",
  "receiptPath": ".judgelock/receipts/example.json"
}
```

JudgeLock permits completion only after it validates the session, fresh
inspection, receipt digest, passed final status, JudgeLock version, repository
identity, baseline/policy commits, current `HEAD`, trusted policy and command
hashes, current layered fingerprint, and every command result.

A missing, failed, or stale receipt returns `COMPLETION_BLOCKED` with exit 6. A
new `verify` removes the old active pointer before doing work, so an interrupted
or failed retry cannot reuse the previous pass.

## Integration behavior

An integration should:

1. pass paths without shell interpolation;
2. treat any nonzero or malformed response as enforcement failure;
3. surface JudgeLock's explanation to the agent;
4. map a denial to the integration's documented blocking mechanism; and
5. still run full `inspect`/`verify` outside the hook path.

Hooks are not a sandbox. They only see tool events the host chooses to emit and
can be removed by a process with sufficient filesystem permissions. CI
enforcement remains the stronger boundary.
