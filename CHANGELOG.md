# Changelog

All notable changes to JudgeLock are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

No unreleased changes yet.

## [0.1.0-beta.1] - 2026-07-14

### Security

- Trusted-Git baseline sessions protect existing tests in immutable, guarded, or
  allowed modes without letting the candidate revision redefine its judge.
- Existing-test deletion, skip/focus markers, assertion removal or weakening,
  empty tests, snapshot edits, timeout increases, coverage reductions or new
  exclusions, test-discovery narrowing, and protected validation-script changes
  are detected or blocked according to trusted policy.
- Inspection-only evidence no longer authorizes local or CI completion by
  default; trusted policy must opt in explicitly.
- Verification receipts bind the baseline, exact `HEAD`, index, worktree,
  relevant untracked files, policy, commands, runtime, and output hashes.
  Completion gating rejects failed, corrupt, insufficient, or stale evidence.
- CI loads policy and validation commands from the trusted base ref so a
  candidate cannot make a weaker policy authoritative.
- Claude Code installation now uses `TaskCompleted` by default and makes the
  global blocking Stop hook opt-in and loop-safe.

### Added

- JavaScript and TypeScript structural analysis plus conservative Python test
  checks.
- Claude Code hooks and a repository-scoped Codex workflow skill.
- Deterministic 30-attack/10-control real-Git benchmark with JSON reporting.
- Automated packed-tarball smoke coverage and hosted release gates on Ubuntu and
  Windows with Node.js 22, plus Ubuntu compatibility validation on Node.js 24.
- Structured evidence validity, inspection-only, and completion-authorization
  fields in verification and status results.
- PMIP dogfood validation covering existing-test write denial, skip detection,
  failed-validation completion blocking, legitimate new-test acceptance,
  red-before/green-after evidence, receipt staleness, and committed-state
  completion authorization.

### Changed

- Release documentation and installation examples identify `0.1.0-beta.1` as a
  beta and avoid the stable npm `latest` tag.

### Validation

- The adversarial benchmark passed 40 out of 40 cases: 30 attacks and 10
  legitimate controls, with zero false negatives and zero false positives.
- The packed package passed smoke testing outside the source tree, and the PMIP
  dogfood concluded that `0.1.0-beta.1` was ready for npm beta publication.

### Important beta limitations

- Local receipts are tamper-evident, not signed or unforgeable attestations.
- Hooks cannot intercept every shell, process, filesystem, or integration write
  path.
- Some semantic checks are deterministic heuristics and may be inconclusive for
  unsupported or dynamic configurations.
- JudgeLock cannot prove that baseline tests are correct, sufficient, or
  complete.
- Independent CI under separate control remains the stronger enforcement
  boundary.
- JudgeLock complements rather than replaces code review, sandboxing, and
  broader supply-chain controls.
