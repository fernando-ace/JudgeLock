# Verification receipts

A JudgeLock receipt is a durable, machine-readable record of what was inspected
and which trusted commands ran. A local completion receipt is valid only while
it remains referenced by the active session and every bound input still matches.

## Lifecycle

1. `start` creates a digested session containing the task, repository
   identifier, baseline and policy commits, trusted policy hash, and JudgeLock
   version.
2. `verify` immediately removes the active receipt pointer. An interrupted or
   failed rerun therefore cannot leave an older pass current.
3. JudgeLock inspects and fingerprints the repository.
4. Trusted validation commands run in order.
5. JudgeLock captures a second inspection and fingerprint. Relevant state
   changes during validation fail the run.
6. A passed receipt is written under the configured `.judgelock/receipts/`
   directory and becomes active. Failed attempts are written separately and
   cannot authorize completion.
7. `status` and `hook can-stop` recalculate current evidence before accepting
   the receipt.

## Bound evidence

Version 1 receipts include:

- schema and JudgeLock versions, local or CI mode, timestamps, runtime, and
  final status;
- session ID and task for local mode;
- a privacy-preserving repository identifier derived from sorted Git root
  commits;
- separate comparison baseline and trusted policy-source commits;
- current `HEAD`, trusted policy hash, and repository-state fingerprint;
- normalized changed-file and inspection results;
- ordered validation command results; and
- a SHA-256 digest over recursively key-sorted canonical JSON, excluding the
  digest field itself.

The repository identifier never contains a remote URL or local filesystem path.
It is intended for stable correlation, not anonymity against someone who already
knows the repository's root commits.

The state fingerprint covers committed, staged, unstaged, and relevant untracked
state; Git object modes and OIDs; index stages; worktree or symlink content
hashes; executable bits; and layer classifications. Moving the same bytes
between staged and unstaged state invalidates the receipt.

## Command evidence

Each result stores:

- a stable name;
- a redacted display form of the command and a hash of the exact trusted
  command;
- start, finish, duration, timeout, status, exit code, and signal;
- SHA-256 hashes of the complete raw stdout and stderr byte streams; and
- bounded, terminal-control-stripped, redacted retained text with byte counts
  and truncation flags.

JudgeLock retains useful head/tail diagnostics within
`retainCommandOutputCharacters`. Truncation does not weaken the complete raw
output hash.

Redaction covers common bearer tokens, credential-bearing URLs, private-key
blocks, known token prefixes, and secret-like assignments. It is best effort.
Validation commands should avoid printing credentials, and CI artifacts from
private repositories should remain access-controlled.

## Validation rules

`status` checks the session digest, receipt digest, final status, JudgeLock
version, repository identifier, session ID, baseline and policy commits, trusted
policy hash, current `HEAD`, repository fingerprint, exact trusted command
identity and order, and successful command results.

`status` is informational and normally exits 0 even when its result says
verification is missing or stale. `hook can-stop` enforces the same evidence and
exits 6 when completion is blocked.

There is no time-to-live in 0.1.0-beta.1. A receipt remains current until a
bound input changes. Any relevant content, Git layer, commit, policy, command,
repository identity, or JudgeLock version change requires verification again.

## No validation commands

An empty trusted command list produces `finalStatus: inspection_only`, no
command results, and a complete repository fingerprint. It is valid evidence but
does not authorize completion unless trusted policy explicitly sets
`validation.allowInspectionOnlyCompletion: true`. Legacy zero-command receipts
mislabeled `passed` are rejected for completion. Full version 1 receipts remain
readable, but a JudgeLock version mismatch requires fresh verification before
completion can be authorized.

Status JSON separates `evidenceValid`, `inspectionOnly`, and
`completionAuthorized`. Human output states that no tests, lint checks, type
checks, or builds were run.

## Trust statement

The receipt digest is tamper-evident, not tamper-proof. It is not signed,
externally timestamped, or issued by a remote authority. A process with write
access to the repository and `.judgelock/` can replace local state. Use an
independently controlled CI run as the stronger control and retain artifacts
according to the repository's security policy.
