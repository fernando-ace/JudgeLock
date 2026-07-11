# Contributing to JudgeLock

Thank you for helping make test-integrity checks easier to trust.

## Before opening a change

- Use Node.js 22 or 24 and a current Git release.
- Keep the core deterministic and local. New network services, LLM judgment, or
  hosted dependencies are outside the 0.1.x architecture.
- Treat compatibility of CLI commands, exit codes, JSON envelopes, finding
  codes, configuration, and receipt schemas as public API work.
- Do not weaken a test to make a change pass. Add a regression test and preserve
  the baseline evidence.
- Do not commit generated `dist/`, `coverage/`, `.judgelock/`, package tarballs,
  logs, credentials, or private repository data.

## Development setup

```sh
npm ci
npm run build
npm test
```

Before submitting a change, run the complete local gate:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run --json
npm run demo
```

Tests that invoke Git should create isolated temporary repositories and set
`user.name` and `user.email` locally. Tests must not depend on the developer's
global Git configuration, default branch name, remotes, or signing setup.

## Design expectations

- Pass subprocess arguments as arrays and do not interpolate untrusted values
  into a shell command.
- Never read authoritative policy or validation commands from the working tree
  during a session or pull-request run.
- Keep analyzers separate from CLI formatting and Commander wiring.
- Fail closed for corrupt enforcement state. Prefer explicit warnings over false
  semantic certainty when static configuration cannot be analyzed.
- Normalize repository-relative paths to `/` and test Windows and POSIX forms.
- Redact retained output, but continue to hash the exact raw bytes.
- Add or update documentation whenever a finding, configuration key, public
  type, or trust boundary changes.

## Pull requests

Keep changes focused and explain:

1. the integrity or usability problem;
2. the chosen behavior and compatibility impact;
3. new tests, including failure-path coverage; and
4. any security limitation that remains.

The validation workflow runs on Node.js 22 and 24. A pull request should not use
`pull_request_target` for code execution.

## Reporting security issues

Do not publish an exploitable bypass in a public issue before maintainers have
had a reasonable opportunity to respond. Follow [`SECURITY.md`](SECURITY.md) for
private reporting guidance.
