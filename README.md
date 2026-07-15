# JudgeLock

JudgeLock is a test-integrity firewall for coding agents. Ordinary CI answers
“does the current code pass the current tests?” JudgeLock additionally records a
trusted Git baseline, blocks changes that weaken that baseline, runs trusted
validation commands, and binds completion evidence to the repository state that
was checked.

Consider a patch that makes a failing task appear successful by changing its
judge:

```diff
-test("rejects duplicate invoices", () => {
-  expect(createInvoice("A-42")).toThrow("duplicate");
-});
+test.skip("rejects duplicate invoices", () => {});
```

JudgeLock reports the evidence change instead of accepting the result:

```text
BLOCKED  EXISTING_TEST_MODIFIED
tests/invoice.test.ts

BLOCKED  SKIPPED_TEST_ADDED
tests/invoice.test.ts:1:1
```

The legitimate workflow keeps the baseline judge intact:

```sh
npm install --save-dev judgelock@beta
npx judgelock start --task "Fix duplicate invoice creation"
# Change production code and add a new regression test.
npx judgelock inspect
npx judgelock verify
npx judgelock hook can-stop
```

> **Package status:** `judgelock@0.1.0-beta.1` is the initial npm beta release.
> It is published under the `beta` distribution tag and is intentionally not
> assigned to `latest` or described as stable.

## What is enforced

| Classification                         | Capabilities                                                                                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fully enforced for matched paths/state | Immutable baseline-test edits, deletion, snapshot changes, protected paths, trusted-base policy loading, policy downgrade rejection, receipt digest/state/command binding, stale-receipt rejection                |
| Deterministic heuristic analysis       | Test renames, skipped/focused tests, assertion removal or weakening, empty tests, literal timeout increases, static coverage reductions/exclusions, static test-discovery narrowing, protected npm-script changes |
| Unsupported                            | Proving original test quality, semantic equivalence for arbitrary frameworks or dynamic configuration, intercepting every shell/filesystem write, signed or unforgeable local attestation                         |

Heuristic checks fail closed for guarded baseline-test edits when analysis is
inconclusive. Under the default `immutable` policy, any baseline-test content
change is independently blocked even when no semantic classification is
available. Git rename classification is supplemental: deleting the old baseline
test remains blocked if a heavily changed rename appears as delete-plus-add.

## Requirements and installation

- Node.js 22 or newer
- Git with at least one commit
- A committed, repository-owned `judgelock.yml`

For normal beta use:

```sh
npm install --save-dev judgelock@beta
npx judgelock --version
```

For reproducible projects and CI, install the exact beta:

```sh
npm install --save-dev --save-exact judgelock@0.1.0-beta.1
```

Release contributors can test an inspected tarball from a reviewed checkout:

```sh
npm ci
npm run build
npm pack
npm install --save-dev ./judgelock-0.1.0-beta.1.tgz
npx judgelock --version
```

JudgeLock does not require `npm link` or a global installation. The release
smoke test installs the real tarball in an unrelated temporary repository.

## Initialize and verify

```sh
npx judgelock init
# Add real lint, type-check, test, and build commands to judgelock.yml.
git add judgelock.yml .gitignore
git commit -m "Add JudgeLock policy"

npx judgelock start --task "Fix invoice rounding"
npx judgelock inspect
npx judgelock verify
npx judgelock hook can-stop
npx judgelock status --json
```

`init` leaves `validation.commands` empty because JudgeLock cannot safely guess
how a project is validated. With the default
`allowInspectionOnlyCompletion: false`, `verify` can still write an
`inspection_only` evidence document, but `hook can-stop` returns exit 6 and CI
returns exit 5. `status` explicitly reports that no tests, lint checks, type
checks, or builds ran. Only a trusted policy can opt in to inspection-only
completion.

## Commands

```text
judgelock init [--force]
judgelock start --task "<description>"
judgelock inspect [--json]
judgelock verify [--json] [--continue-on-failure]
judgelock status [--json]
judgelock explain <violation-code>
judgelock hook can-write --path <path> [--json]
judgelock hook can-stop [--json]
judgelock ci --base-ref <ref> [--json]
judgelock install claude-code [--autonomous-stop-hook]
judgelock uninstall claude-code
```

JSON commands emit one versioned envelope. Verification and status results
expose `evidenceValid`, `inspectionOnly`, and `completionAuthorized`; consumers
do not need to parse human warnings.

| Exit | Meaning                                                        |
| ---: | -------------------------------------------------------------- |
|    0 | Command succeeded or hook allowed                              |
|    1 | Unexpected internal error                                      |
|    2 | Invalid argument or configuration                              |
|    3 | Missing Git/session/clean-baseline prerequisite                |
|    4 | Policy violation or denied write                               |
|    5 | Verification, command, state-change, or CI completion failure  |
|    6 | Completion blocked by missing, stale, or insufficient evidence |
|    7 | Corrupt JudgeLock state or receipt                             |
|    8 | Integration installation failure                               |

## CI and other test tools

Ordinary CI proves that current code passes current tests. Test-quality linters
inspect style or suspicious patterns in test code. JudgeLock protects a trusted
baseline and trusted validation policy, then binds the result to exact relevant
Git, index, worktree, and untracked state. These controls complement one
another.

`judgelock ci --base-ref <trusted-ref>` loads policy bytes and commands from the
resolved base-ref tip; the candidate revision cannot make its own weaker policy
authoritative. Use an unprivileged `pull_request` workflow with full Git history
and no secrets. See [the CI guide](docs/ci.md) and the
[ready-copy example](examples/github-actions/judgelock.yml).

## Agent hooks

`hook can-write` provides deterministic early path decisions for integrations,
but arbitrary shell commands can bypass pre-write hooks. `inspect`, `verify`,
and independent CI remain authoritative.

`judgelock install claude-code` installs:

- `PreToolUse` for `Edit|Write`; and
- `TaskCompleted` for workflows that explicitly use Claude Code tasks.

It does not block every normal Claude `Stop` by default, so clarification,
partial-progress, waiting-for-input, and recovery responses can end normally.
`--autonomous-stop-hook` enables a blocking Stop gate only for autonomous
single-task sessions. The launcher honors `stop_hook_active` to avoid loops and
does not interpret `last_assistant_message` with an LLM or textual heuristic.
See [the Claude Code integration guide](docs/integrations/claude-code.md).

## Receipts and limitations

A receipt binds the baseline, current `HEAD`, staged and unstaged state,
relevant untracked files, trusted policy, command identities, runtime, and
complete output hashes. Retained output is bounded and redacted; the full raw
stream is hashed before truncation.

A local receipt is tamper-evident, not unforgeable. It is not signed and is not
a cryptographic attestation. A user who can rewrite repository and JudgeLock
state can recompute local digests. Independent CI under separate control is the
stronger enforcement boundary.

JudgeLock cannot prove that application code is correct, that tests are
sufficient, or that ignored paths are irrelevant. Validation commands execute
repository code and should run without secrets in a sandboxed CI job.

Further documentation:

- [Configuration](docs/configuration.md)
- [Receipts](docs/receipts.md)
- [Hooks](docs/hooks.md)
- [Security model](docs/security-model.md)
- [Architecture](docs/architecture.md)
- [Violation codes](docs/violations.md)

## Release validation

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run benchmark
npm run benchmark -- --json
npm pack --dry-run --json
npm run smoke:package
npm run demo
```

`npm run benchmark` applies 30 known attacks and 10 legitimate controls to
disposable real Git repositories. It exits nonzero if an attack escapes, a
control is blocked, or an expected decision code is missing. The repository CI
runs the full release gates on Ubuntu and Windows with Node.js 22, plus source
validation on Ubuntu with Node.js 24.

During the 2026-07-14 release audit, the command passed **40/40 cases with zero
false negatives and zero false positives** on Windows and Linux Node.js 22. The
packed-package smoke also passed on both platforms with 22 allowlisted tarball
entries.

JudgeLock is MIT licensed. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md) before contributing or reporting a vulnerability.
