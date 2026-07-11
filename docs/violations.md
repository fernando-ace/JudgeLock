# Violation reference

Every finding has a stable `code`, `severity`, normalized repository-relative
`path`, optional line and column, `confidence`, explanation, and remediation.
Run `judgelock explain <code>` for the installed version's CLI explanation.

| Code                         | Meaning                                                                                   | Typical remediation                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `CONFIG_CHANGED`             | The candidate changed `judgelock.yml` contrary to trusted policy.                         | Revert the policy change or land an intentional trusted-base policy update separately. |
| `EXISTING_TEST_MODIFIED`     | An immutable baseline test's bytes, mode, or type changed.                                | Restore it and add a new regression test.                                              |
| `TEST_RENAMED`               | A baseline test moved or was renamed.                                                     | Preserve the original path; add a new test file if needed.                             |
| `TEST_DELETED`               | A baseline test was deleted.                                                              | Restore the test.                                                                      |
| `NEW_TEST_NOT_ALLOWED`       | A new test was added while `allowNewTests` is false.                                      | Remove it or change trusted policy in a separate review.                               |
| `SNAPSHOT_CHANGED`           | A protected snapshot was added, changed, moved, deleted, or type-changed.                 | Restore snapshots and assert the intended behavior explicitly.                         |
| `SKIPPED_TEST_ADDED`         | A new skip, xfail, pending marker, or skipped suite/test was introduced.                  | Make the test execute or remove the new skipped case.                                  |
| `FOCUSED_TEST_ADDED`         | A new `.only`, `fdescribe`, `fit`, or equivalent focus marker was introduced.             | Remove the focus marker and run the full suite.                                        |
| `TEST_CASE_REMOVED`          | Guarded analysis found a baseline suite or case missing.                                  | Restore the case without narrowing its scope.                                          |
| `ASSERTION_REMOVED`          | Guarded analysis found fewer baseline assertions or an expected-error check was removed.  | Restore the assertion or preserve it while adding stronger evidence.                   |
| `ASSERTION_WEAKENED`         | A clear assertion transition became less specific or permissive.                          | Keep the stronger baseline assertion and add any new case separately.                  |
| `ASSERTION_MISSING`          | A test body became empty or no longer contains a recognized assertion/effect.             | Add a meaningful assertion without removing baseline evidence.                         |
| `TIMEOUT_INCREASED`          | A literal runner, suite, test, or fixture timeout increased.                              | Fix the slow behavior or land an independently reviewed timeout policy change.         |
| `COVERAGE_THRESHOLD_REDUCED` | A supported static configuration lowered or removed a coverage threshold.                 | Restore the baseline threshold.                                                        |
| `COVERAGE_EXCLUSION_ADDED`   | Coverage omissions or inline exclusion directives expanded.                               | Remove the exclusion and test the code.                                                |
| `TEST_DISCOVERY_NARROWED`    | Test selection, include/project configuration, or a trusted command now runs fewer tests. | Restore broad discovery and remove targeting flags.                                    |
| `VALIDATION_SCRIPT_CHANGED`  | A protected package script or its reachable dependency changed.                           | Restore the trusted script or update trusted policy in a separate change.              |
| `PROTECTED_PATH_CHANGED`     | A path matching `protectedPatterns` changed.                                              | Revert it or revise trusted policy separately.                                         |
| `INTEGRATION_CONFIG_CHANGED` | A JudgeLock-managed hook setting or launcher changed during a session.                    | Restore or reinstall the integration outside the active session.                       |
| `TEST_ANALYSIS_FAILED`       | A test could not be parsed or scanned safely.                                             | Correct the syntax or use supported static patterns; do not bypass analysis.           |
| `ANALYSIS_INCONCLUSIVE`      | Static analysis could not determine a configuration or semantic change confidently.       | Simplify to supported static configuration or review the guarded edit separately.      |
| `UNMERGED_PATH`              | The Git index contains unresolved stages.                                                 | Resolve the merge conflict and rerun inspection.                                       |

## Blocking and warning findings

Blocking findings make inspection fail with exit 4. Warnings record limitations
or reduced evidence without automatically blocking unless the active policy
requires certainty. In particular, an inconclusive guarded edit to an existing
test blocks because JudgeLock cannot prove that the test stayed at least as
strong.

Pre-existing skip and focus markers are compared against the baseline and are
not reported as newly introduced findings. New test files are allowed by
default, but their skip/focus markers and other independent integrity rules
still apply.
