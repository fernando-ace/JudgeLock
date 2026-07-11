# Architecture

JudgeLock has one job: evaluate a repository change against policy and
validation commands that the change itself cannot redefine.

## Components

1. **Configuration loader** parses strict, versioned YAML and returns actionable
   diagnostics.
2. **Git adapter** invokes Git without a command shell, reads trusted blobs and
   trees, and captures committed, staged, unstaged, untracked, renamed, and
   unmerged state.
3. **Fingerprint builder** canonicalizes relevant repository state and hashes
   the resulting manifest.
4. **Analyzers** compare baseline and current test, snapshot, coverage,
   test-discovery, timeout, script, protected-path, and integration
   configuration evidence.
5. **Policy engine** converts analyzer evidence into stable findings and an
   inspection result.
6. **Verifier** invalidates the previous active receipt, runs trusted commands,
   confirms state stability, and writes a digested receipt.
7. **Hook and CI adapters** expose fast write/stop decisions and independent
   pull-request enforcement without embedding policy logic in an agent
   integration.
8. **CLI presenters** render either human text or one JSON envelope without
   changing domain results.

Analyzers do not depend on Commander. Git operations, policy decisions, command
execution, state persistence, and presentation stay separable so each trust
boundary can be tested directly.

## Local data flow

```text
clean Git repository
        |
        v
start --task
  read judgelock.yml from HEAD
  record baseline commit, policy hash, repository ID, session digest
        |
        v
agent edits committed/staged/unstaged/untracked state
        |
        v
inspect
  capture layered state -> fingerprint -> analyzers -> findings
        |
        v
verify
  invalidate active receipt
  inspect/fingerprint before commands
  run trusted baseline commands
  inspect/fingerprint after commands
  write passed receipt + active pointer only if all checks pass
        |
        v
can-stop/status
  revalidate session, receipt digest, policy, commands, version, and fingerprint
```

`start` requires an existing commit and a completely clean tracked and untracked
tree. This makes the baseline unambiguous. A new valid session supersedes the
older one. Corrupt state fails closed for enforcement commands; recovery is
explicit rather than silently trusting malformed bytes.

## Trusted policy selection

Local mode reads `judgelock.yml` from the session's baseline commit. The
working-tree file can be inspected as a change, but it is never authoritative.

CI mode resolves the user-supplied base ref to a commit and reads policy from
that base-tip commit. It separately computes the merge base between the base tip
and `HEAD` to classify pull-request changes. This split is intentional:

- **base-tip commit:** policy authority and validation commands;
- **merge-base commit:** comparison baseline for pull-request changes;
- **pull-request `HEAD`:** candidate state being judged.

Unless trusted base policy explicitly sets `ci.allowPolicyChanges: true`,
changing `judgelock.yml` in the candidate produces `CONFIG_CHANGED`. Even when
allowed, CI continues to use the trusted base policy for that run.

## Repository state model

JudgeLock captures four change layers:

- committed changes from baseline to current `HEAD`;
- staged changes from `HEAD` to the index;
- unstaged changes from the index to the worktree; and
- relevant, Git-unignored untracked content.

The fingerprint manifest records baseline and `HEAD` Git object mode/OID, all
index stages, worktree file or symlink hashes, executable state, layer
classification, and rename source. Consequently, staging or unstaging identical
content changes the fingerprint. Unmerged index stages block inspection with
`UNMERGED_PATH`.

`.git/**` and `.judgelock/**` are always excluded from content inspection.
Ordinary ignored patterns remove build output and similar noise, while explicit
protected patterns take precedence. Submodule Git-link changes are captured, but
nested submodule worktrees are not recursively inspected in 0.1.0.

Files are statted before and after hashing and Git status is recaptured.
JudgeLock retries a changing snapshot twice, then reports unstable state rather
than signing off on a mixed-time view.

## Static analysis boundary

JavaScript and TypeScript tests are parsed with Babel. Python tests use a
conservative indentation-aware scanner. Supported static JSON, YAML, TOML, and
INI configuration is read as data. JudgeLock does not execute JavaScript or
TypeScript configuration in order to analyze it.

Clear weakening evidence blocks according to policy. Ambiguous global
configuration produces a warning. A guarded existing-test edit whose semantics
cannot be analyzed confidently blocks because JudgeLock cannot establish that
the evidence remained at least as strong.

## Persistence

Runtime state lives under `.judgelock/`, which should remain Git-ignored:

```text
.judgelock/
  session.json
  active-receipt.json
  receipts/
  attempts/
  backups/
```

Session and receipt documents carry a SHA-256 digest over recursively key-sorted
canonical JSON. Writes are atomic. Failed verification artifacts are kept
separately from completion receipts and cannot satisfy `can-stop`.
