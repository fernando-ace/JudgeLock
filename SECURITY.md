# Security Policy

## Supported versions

JudgeLock is pre-release software. Security fixes are applied to the latest
released minor version.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| Earlier | No        |

## Reporting a vulnerability

Use the repository host's private vulnerability-reporting feature when one is
available. If it is not available, contact the maintainers through a non-public
channel shown on the repository profile. Do not include secrets, private source
code, raw receipts from private repositories, or exploit details in a public
issue.

Include:

- the affected JudgeLock version, Node.js version, operating system, and Git
  version;
- whether the issue affects local sessions, hooks, CI, or receipt validation;
- a minimal disposable repository or exact reproduction steps;
- the expected and observed finding, exit code, and hook decision; and
- the security impact and any known workaround.

You should receive an acknowledgment when a maintainer reviews the report. No
fixed response or disclosure timeline is promised while the project is
maintained by volunteers.

## Security posture

JudgeLock is a deterministic policy and evidence tool, not a sandbox. A local
agent commonly runs with the same operating-system permissions as JudgeLock and
may bypass, disable, or replace local hooks and state. Treat `hook can-write` as
early feedback and `hook can-stop` as a completion gate, not as isolation.

The recommended control is an unprivileged, independently managed `pull_request`
workflow that checks out the exact head SHA and loads policy and validation
commands from the trusted base-ref tip. Never run untrusted pull-request code
with `pull_request_target` privileges or repository secrets.

Receipts use SHA-256 digests to reveal accidental or unauthorized changes to
captured state. They are not signed, not externally timestamped, and not
cryptographic attestations. Output redaction is defense in depth: validation
commands should not print secrets in the first place.

See [`docs/security-model.md`](docs/security-model.md) for threat boundaries and
known limitations.
