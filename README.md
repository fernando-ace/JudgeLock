# JudgeLock

JudgeLock is an open-source test-integrity firewall for coding agents. It
records a trusted Git baseline, detects attempts to weaken the evidence used to
judge a task, runs repository-owned validation commands, and issues a
tamper-evident receipt for the exact repository state that passed.

JudgeLock does not decide whether application code is correct. It makes it
harder for an automated change to appear successful by deleting, skipping,
narrowing, or weakening the tests and validation rules that were supposed to
judge it.

The operating principle is simple: **an agent should not grade its own
homework**. The agent may change the contestant (production code and genuinely
new regression tests), but it may not silently rewrite the judge.

> **Package status:** `judgelock@0.1.0` is not published to npm yet. Commands
> below use a source checkout or locally packed tarball. The version-pinned npm
> CI example becomes directly usable after publication.

## Requirements

- Node.js 22 or newer
- Git with at least one commit
- A repository-owned `judgelock.yml` committed to the trusted baseline

## Install from source

```sh
cd /path/to/JudgeLock
npm ci
npm run build
npm link
judgelock --version
```

To avoid a global link, invoke `node /absolute/path/to/JudgeLock/dist/cli.js`
wherever the examples use `judgelock`. You can also run `npm pack`, install the
resulting tarball into a separate tool directory, and invoke its binary from
there.

After the package is published, the five-minute workflow is:

```sh
npm install --save-dev judgelock
npx judgelock init
git add judgelock.yml .gitignore
git commit -m "Add JudgeLock policy"
npx judgelock start --task "Fix duplicate invoice creation"

# Let the coding agent work.
npx judgelock inspect
npx judgelock verify
npx judgelock status
```

## Quick start

Run initialization in the repository that should be protected:

```sh
cd my-project
judgelock init
```

Review `judgelock.yml`, add real project commands under `validation.commands`,
then commit it. `init` deliberately leaves that list empty because JudgeLock
cannot safely guess how a repository is validated.

Start an agent task only from a completely clean repository:

```sh
judgelock start --task "Fix invoice rounding"
# Let the agent edit the repository and add regression tests.
judgelock inspect
judgelock verify
judgelock hook can-stop
judgelock status
```

The safe agent workflow is **start → add-only regression test → inspect → verify
→ can-stop → report the receipt**. With the default `immutable` policy, existing
baseline tests cannot change, while new tests are allowed and still checked for
skips, focus markers, and other weakening patterns.

An empty validation list is valid. In that case `verify` creates an
inspection-only receipt and emits `NO_VALIDATION_COMMANDS`; no project lint,
type-check, or tests were run.

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
judgelock install claude-code
judgelock uninstall claude-code
```

`inspect` analyzes current changes without running validation commands. `verify`
invalidates any prior active receipt, inspects, fingerprints, runs trusted
commands, and confirms that relevant state did not change while they ran.
`status` is informational and normally exits successfully even when another
verification is required. Use `--json` for one machine-readable result document.

| Exit | Meaning                                                             |
| ---: | ------------------------------------------------------------------- |
|    0 | Success or hook allow                                               |
|    1 | Unexpected internal error                                           |
|    2 | Invalid argument or configuration                                   |
|    3 | Missing Git history, session, clean baseline, or other prerequisite |
|    4 | Policy violation or denied write                                    |
|    5 | Validation command or verification state-change failure             |
|    6 | Completion blocked by a missing or stale receipt                    |
|    7 | Corrupt JudgeLock state                                             |
|    8 | Integration installation failure                                    |

## CI

Independent CI is the strongest JudgeLock control. The ready-copy npm workflow
in
[`examples/github-actions/judgelock.yml`](examples/github-actions/judgelock.yml)
uses an unprivileged `pull_request` trigger, full Git history, the exact
pull-request head SHA, and a trusted base ref. Until the npm package is
published, replace its pinned `npm exec` step with an invocation of a reviewed
local checkout or tarball.

In CI, policy bytes and validation commands come from the resolved base-ref tip.
The merge base is used only to classify pull-request changes. A pull request
cannot make its own policy authoritative.

## Agent hooks

`hook can-write` is a fast pre-write decision for integrations. It blocks
policy/state/integration files, protected files, immutable existing tests,
protected snapshots, and disallowed new tests. Guarded test edits still require
authoritative content analysis by `inspect`.

`hook can-stop` permits completion only when the active local session points to
a passed, digest-valid receipt for the current repository fingerprint and
trusted command set. Hooks improve the feedback loop; they are not a security
boundary and cannot intercept every way a process might modify files.

See [`docs/hooks.md`](docs/hooks.md) for the hook contract. Integration-specific
installation guides live under `docs/integrations/`.

## What a receipt means

A receipt binds a result to the baseline commit, current `HEAD`, staged and
unstaged state, relevant untracked content, trusted policy, command identities,
runtime, and complete output hashes. It is protected by a canonical SHA-256
digest, but it is not a signature or a cryptographic attestation. Anyone who can
rewrite repository state can also replace local JudgeLock state, which is why an
independently controlled CI run matters.

Learn more in:

- [`docs/configuration.md`](docs/configuration.md)
- [`docs/violations.md`](docs/violations.md)
- [`docs/receipts.md`](docs/receipts.md)
- [`docs/ci.md`](docs/ci.md)
- [`docs/architecture.md`](docs/architecture.md)
- [`docs/security-model.md`](docs/security-model.md)

## Important limitations

- JudgeLock cannot prove that the original tests or their expectations are
  correct.
- Assertion and configuration analysis deliberately uses documented,
  deterministic heuristics rather than claiming full semantic equivalence.
- A fully malicious local user can replace local state and recompute receipt
  digests; CI controlled outside the change is the stronger check.
- Verification commands execute repository code and belong in an unprivileged,
  sandboxed CI job without secrets.
- JudgeLock reduces false confidence; it does not replace code review.

## Demo

The demo creates a disposable real Git repository, proves that a cheating test
edit is blocked, applies a legitimate source fix with a new regression test,
verifies it, then proves that a later source change makes the receipt stale.

```sh
npm ci
npm run demo
```

Run `node examples/vulnerable-demo/demo.mjs --keep` after building to retain the
temporary repository and print commands for manual exploration.

## Development

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run --json
npm run demo
```

JudgeLock is MIT licensed. See [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`SECURITY.md`](SECURITY.md) before contributing or reporting a vulnerability.
