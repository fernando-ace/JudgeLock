# Security model

JudgeLock protects the integrity of test and validation evidence during an
automated coding task. Its design assumes Git history and the CI base ref are
more trusted than the candidate working tree.

## Security goals

JudgeLock aims to:

- prevent a candidate change from making its own policy or validation commands
  authoritative;
- detect clear deletion, skipping, focusing, weakening, narrowing, timeout,
  snapshot, coverage, and protected-file changes;
- bind a successful result to the exact relevant Git and filesystem layers that
  were checked;
- invalidate stale or failed local verification promptly;
- avoid leaking raw repository location, remotes, environment variables, or
  obvious secrets into receipts; and
- make enforcement failures explicit through stable nonzero exits.

## Trust boundaries

Trusted inputs are:

- local session policy bytes from the clean baseline commit;
- CI policy bytes and commands from the resolved base-ref tip;
- the JudgeLock executable and Node.js/Git runtime supplied by the operator or
  CI; and
- the CI workflow, runner permissions, artifact access controls, and protected
  base branch.

Candidate inputs include `HEAD`, the index, worktree, untracked files,
pull-request policy edits, test/config source, and command output. They are
parsed and hashed but never trusted to redefine the current policy.

## Threats addressed

- Editing, renaming, deleting, skipping, focusing, or clearly weakening baseline
  tests.
- Adding protected snapshot changes or coverage exclusions.
- Lowering clear coverage thresholds or increasing literal timeouts.
- Narrowing test discovery or changing protected validation scripts.
- Changing staged/unstaged placement after verification.
- Mutating relevant state while validation commands run.
- Reusing a receipt after relevant state, trusted commands, policy, version, or
  repository identity changes.
- Supplying a weaker pull-request policy to CI.
- Corrupting session or receipt JSON without updating its canonical digest.

## Limitations

JudgeLock is not:

- an operating-system sandbox or process monitor;
- a guarantee that tests are sufficient or application code is correct;
- a semantic theorem prover for arbitrary test frameworks or dynamic
  configuration;
- a mutation-testing system;
- a signed supply-chain attestation or remote approval service;
- protection against a compromised JudgeLock binary, Git/Node runtime, CI
  runner, base branch, or workflow; or
- protection against an administrator who can rewrite both repository history
  and enforcement infrastructure.

Local agent hooks are advisory enforcement running with the agent's permissions.
They cannot intercept every shell, filesystem API, interrupt, crash, or
integration escape. Claude Code `Edit|Write` hooks do not cover arbitrary Bash
mutations, and Stop hooks do not run for every interruption or API failure.
Always run authoritative `inspect` and `verify`, and use independent CI for
review gates.

Static analysis intentionally does not execute JavaScript or TypeScript
configuration. Dynamic or unsupported forms may produce `ANALYSIS_INCONCLUSIVE`.
Guarded baseline-test edits fail when JudgeLock cannot establish safety;
ambiguous global configuration is disclosed as a warning rather than
misrepresented as fully analyzed.

Submodule Git-link changes are fingerprinted, but 0.1.0 does not recurse into
nested submodule worktrees. Ignored files are outside the fingerprint unless
explicitly protected. Choose ignored and protected patterns carefully.

## CI hardening

- Trigger on `pull_request`, never `pull_request_target`, when executing
  candidate code.
- Grant only `contents: read` unless a reviewed workflow needs more.
- Check out the exact pull-request head SHA with full history.
- Fetch and pass an explicit remote-tracking base ref.
- Pin JudgeLock to an exact reviewed version.
- Do not expose repository secrets to validation commands from an untrusted
  fork.
- Upload receipts with `if: always()` and restrict artifact readers
  appropriately.
- Protect changes to the base policy and workflow through ordinary branch
  review.

## Output and privacy

Receipt output redaction is best-effort defense in depth. JudgeLock hashes
complete raw output but persists only bounded redacted text; environment
variables themselves are not serialized. A hash can still confirm a guessed
value, so receipts from private work should be treated as sensitive operational
artifacts.

The repository identifier is derived from Git root commits, not remote URLs or
local paths. It prevents accidental location disclosure but is not designed to
resist correlation by someone who possesses the same commits.

## Recovery

Enforcement commands fail closed on corrupt state. Do not hand-edit
`.judgelock/` to make a denial disappear. Preserve relevant artifacts for
diagnosis, end the untrusted task, return the repository to a reviewed clean
state, and start a new session. Integration installers keep backups under
`.judgelock/backups/`; inspect them for sensitive settings before sharing.
