# Configuration

JudgeLock reads `judgelock.yml` from trusted Git history. Local sessions use the
baseline commit recorded by `start`; CI uses the resolved base-ref tip. Editing
the working-tree policy never changes the policy governing the current run.

## Default policy

```yaml
version: 1

testIntegrity:
  existingTests: immutable
  allowNewTests: true
  blockDeletedTests: true
  blockSnapshotChanges: true
  blockSkippedTests: true
  blockFocusedTests: true
  blockAssertionRemoval: true
  blockAssertionWeakening: true
  blockTimeoutIncreases: true

coverage:
  blockThresholdReductions: true
  blockNewExclusions: true

validation:
  protectScripts: true
  commands: []
  # - name: lint
  #   command: npm run lint
  #   timeoutSeconds: 120
  # - name: typecheck
  #   command: npm run typecheck
  #   timeoutSeconds: 120
  # - name: tests
  #   command: npm test
  #   timeoutSeconds: 300

paths:
  testPatterns:
    - "**/*.test.{js,jsx,ts,tsx}"
    - "**/*.spec.{js,jsx,ts,tsx}"
    - "**/__tests__/**"
    - "test/**"
    - "tests/**"
    - "**/test_*.py"
    - "**/*_test.py"
  snapshotPatterns:
    - "**/__snapshots__/**"
    - "**/*.snap"
  protectedPatterns: []
  ignoredPatterns:
    - "node_modules/**"
    - "dist/**"
    - "build/**"
    - ".git/**"
    - ".judgelock/**"

receipt:
  directory: ".judgelock/receipts"
  retainCommandOutputCharacters: 8000

ci:
  allowPolicyChanges: false
```

`judgelock init` writes this file and adds `.judgelock/` to `.gitignore`. It
refuses to overwrite an existing policy unless `--force` is supplied.
Initialization never invents project commands.

## Test integrity

`existingTests` controls edits to files that matched a test pattern in the
comparison baseline:

- `immutable` blocks content, executable-mode, deletion, type, and rename
  changes to existing tests.
- `guarded` permits an edit only when JudgeLock can analyze it confidently and
  every enabled weakening check passes.
- `allowed` removes the blanket edit block and assertion-delta checks.
  Independent deletion, skip/focus, snapshot, timeout, protected-path,
  discovery, and validation rules still apply.

`allowNewTests` controls whether a previously absent test path may be added. New
tests are still checked for skipped or focused cases and other independently
enabled rules.

The remaining booleans enable deletion, snapshot, newly skipped/focused test,
assertion removal/weakening, and timeout-increase checks. Disabling one check
does not disable the others.

## Coverage

`blockThresholdReductions` protects clear numeric coverage threshold reductions
in supported static configuration. `blockNewExclusions` detects newly expanded
omit/exclude patterns and new inline Istanbul, c8, or `pragma: no cover`
directives.

Dynamic configuration is not executed. If JudgeLock cannot interpret a
configuration safely, it reports `ANALYSIS_INCONCLUSIVE` rather than claiming
semantic coverage it did not establish.

## Validation commands

Commands run in listed order at the repository root through the platform shell.
Each entry requires:

- `name`: a unique stable name;
- `command`: the exact trusted command string; and
- `timeoutSeconds`: a positive bounded timeout.

Environment variables are inherited by the process but never serialized into the
receipt. Verification stops at the first failed command unless
`--continue-on-failure` is used. Continuing gathers more results but never turns
a failed run into a pass.

When `protectScripts` is true, JudgeLock protects conventional and
command-referenced npm scripts, including reachable `pre`, `post`, and nested
`npm run` dependencies, from changes that narrow validation or alter what a
trusted command executes.

An empty `commands` list is intentionally valid. Verification then performs
integrity inspection only, emits `NO_VALIDATION_COMMANDS`, and records no
command results. Such a receipt may authorize `can-stop`, but it is explicit
evidence that no project lint, type-check, or tests ran.

## Paths

Patterns use repository-relative `/` paths and micromatch-style globs. JudgeLock
rejects absolute paths, NUL bytes, `..` escapes, leading-negation patterns, and
malformed globs.

- `testPatterns` identifies test files.
- `snapshotPatterns` identifies snapshots.
- `protectedPatterns` names files that must not change during a session.
- `ignoredPatterns` removes irrelevant paths from ordinary inspection and
  fingerprinting.

`.git/**` and `.judgelock/**` are hard exclusions. Explicit protected patterns
override ordinary ignored patterns. Use forward slashes even when authoring
policy on Windows.

## Receipts and CI

`receipt.directory` must be a path below `.judgelock/`.
`retainCommandOutputCharacters` bounds redacted diagnostic text, not the
complete output hash.

`ci.allowPolicyChanges` is trusted-base policy. Its default `false` blocks a
candidate change to `judgelock.yml`. Setting it to `true` permits the file
change to proceed, but that candidate policy still does not govern the current
CI run.

## Validation and diagnostics

Every configuration object is strict: misspelled or unknown keys are errors.
JudgeLock also rejects duplicate validation command names, invalid timeouts,
unsafe paths, and an unsupported `version`. YAML syntax and schema errors
include the closest available line and column plus a remediation message.
