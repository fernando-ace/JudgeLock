# Codex skill

JudgeLock ships a repo-scoped Codex skill at
`.agents/skills/judgelock/SKILL.md`. When the package is present in a
repository, Codex can use `$judgelock` to follow the protected workflow:

```text
start -> add-only regression test -> inspect -> verify -> can-stop -> report receipt
```

Copy `.agents/skills/judgelock/` into the same path in another repository if the
package manager does not preserve dot-directories from the installed package.
Keep `judgelock.yml` at the Git root and install the exact JudgeLock version
used by that repository.

You can add this concise instruction to `AGENTS.md`:

```md
When `judgelock.yml` is present, use the `$judgelock` skill. Start a session
before edits, preserve every baseline test, prefer a new regression-test file,
inspect and verify, then require `judgelock hook can-stop` and report the active
receipt before claiming completion.
```

The skill improves agent cooperation but cannot enforce its own instructions.
JudgeLock's CLI, tamper-evident receipt checks, and independent CI are the
enforcement controls.
