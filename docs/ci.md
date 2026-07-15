# Continuous integration

JudgeLock CI evaluates candidate code using policy and validation commands
loaded from trusted base-branch history.

## Required Git shape

The runner must have:

- the exact candidate `HEAD` checked out;
- complete history sufficient to compute a merge base; and
- an explicit ref that resolves to the trusted base-branch tip.

Run:

```sh
judgelock ci --base-ref origin/main --json
```

JudgeLock resolves `origin/main` once as the policy-source commit, reads
`judgelock.yml` from that commit, and computes its merge base with candidate
`HEAD` for change classification. It never executes commands from the candidate
policy.

`ci.allowPolicyChanges: false` in trusted policy blocks a candidate policy edit.
If trusted policy sets it to `true`, the edit may accompany the pull request,
but only a later run where that change is already on the base branch can use the
new policy.

## GitHub Actions example

[`examples/github-actions/judgelock.yml`](../examples/github-actions/judgelock.yml)
is a ready-copy workflow for an npm-based repository. It intentionally pins the
public beta at `judgelock@0.1.0-beta.1` and:

- uses only `pull_request` and `contents: read`;
- checks out `github.event.pull_request.head.sha` with `fetch-depth: 0`;
- fetches the base branch into an explicit remote-tracking ref;
- installs project dependencies deterministically with `npm ci`;
- invokes an exact JudgeLock version; and
- uploads receipt and failed-attempt artifacts even when enforcement fails.

Do not change the trigger to `pull_request_target`: doing so can execute
untrusted candidate code in a privileged secrets context.

Use the exact beta in CI rather than the mutable `beta` tag. For local beta use,
install `judgelock@beta`; for reproducible workflows, keep
`npm exec --package judgelock@0.1.0-beta.1`. Do not commit a machine-specific
absolute path into a shared workflow.

## Other CI systems

The same trust requirements apply outside GitHub Actions:

1. obtain candidate source without secrets or write credentials;
2. fetch full base history;
3. check out the exact candidate commit, not a mutable branch name;
4. resolve a reviewed base ref in the local clone;
5. install an exact JudgeLock version from a trusted source;
6. install dependencies required by trusted validation commands;
7. run `judgelock ci --base-ref <trusted-ref> --json`; and
8. preserve `.judgelock/receipts/` and `.judgelock/attempts/` with restricted
   access.

CI mode does not require `judgelock start`; the trusted base and candidate head
define the run.

## Interpreting failures

| Exit | CI interpretation                                                                 |
| ---: | --------------------------------------------------------------------------------- |
|    0 | Integrity inspection and every configured validation command passed.              |
|    2 | Trusted policy or CLI arguments are invalid.                                      |
|    3 | Required Git history, candidate commit, or base ref is missing.                   |
|    4 | Candidate changes violate trusted policy.                                         |
|    5 | Validation failed, state changed, or empty commands did not authorize completion. |
|    7 | Persisted JudgeLock state is corrupt.                                             |

When the trusted base policy configures no commands, CI writes `inspection_only`
evidence and exits 5 by default. Exit 0 is possible only when that same trusted
policy explicitly sets `validation.allowInspectionOnlyCompletion: true`; the
receipt and JSON output remain labeled inspection-only.
