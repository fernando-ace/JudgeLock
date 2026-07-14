# Changelog

All notable changes to JudgeLock are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

No unreleased changes yet.

## [0.1.0-beta.1] - 2026-07-14

### Security

- Inspection-only evidence no longer authorizes local or CI completion by
  default; trusted policy must opt in explicitly.
- Claude Code installation now uses `TaskCompleted` by default and makes the
  global blocking Stop hook opt-in and loop-safe.

### Added

- Deterministic 30-attack/10-control real-Git benchmark with JSON reporting.
- Automated packed-tarball smoke coverage and Ubuntu/Windows release gates.
- Structured evidence validity, inspection-only, and completion-authorization
  fields in verification and status results.

### Changed

- Release version and documentation claims are narrowed to verified
  `0.1.0-beta.1` behavior.

## [0.1.0] - 2026-07-10

### Added

- Trusted-Git local sessions, layered repository fingerprints, and
  tamper-evident verification receipts.
- Immutable, guarded, and allowed existing-test policies with JavaScript,
  TypeScript, and Python integrity analysis.
- Snapshot, coverage, test-discovery, validation-script, timeout,
  protected-path, and integration configuration checks.
- Stable human and JSON CLI contracts for initialization, inspection,
  verification, status, hook decisions, CI, and violation explanations.
- Claude Code hook installer and a repository-scoped Codex skill.
- Unprivileged GitHub Actions example, end-to-end vulnerable-project demo,
  security model, and reference documentation.
