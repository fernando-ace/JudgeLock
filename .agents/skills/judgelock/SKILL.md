---
name: judgelock
description:
  Preserve test integrity while implementing changes in a JudgeLock-protected
  Git repository. Use when a repository contains judgelock.yml or the user asks
  Codex to start, inspect, verify, or finish a JudgeLock session without
  weakening existing tests.
---

# JudgeLock workflow

Treat JudgeLock as the authoritative local test-integrity check. The skill
guides cooperation; it is not a security boundary.

1. Start before changing files:

   ```text
   judgelock start --task "<concise task description>"
   ```

   If start reports a dirty repository, do not discard or overwrite the existing
   work. Ask the user how to handle it.

2. Implement the production change. Preserve existing tests. Add a focused
   regression test as a new test file when practical; never skip, focus, delete,
   weaken, or rewrite a baseline test to make the change pass.

3. Inspect before running project validation:

   ```text
   judgelock inspect
   ```

   Resolve every blocking finding without weakening validation. If a finding
   appears incorrect, report its code and evidence instead of bypassing
   JudgeLock.

4. Run the trusted validation commands and create a fresh receipt:

   ```text
   judgelock verify
   ```

   A failed or interrupted verification invalidates any prior active receipt.
   Fix the implementation and verify again.

5. Confirm that completion is authorized:

   ```text
   judgelock hook can-stop
   judgelock status --json
   ```

6. Report the inspection result, commands run, completion decision, and active
   receipt path. If the configuration has no validation commands, state
   explicitly that JudgeLock performed inspection only and did not run project
   lint, type-check, or tests.

Do not edit `judgelock.yml`, `.judgelock/**`, `.claude/settings.json`, or
`.claude/hooks/judgelock.cjs` during an active session. Independent CI remains
the stronger enforcement control.
