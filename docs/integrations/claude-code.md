# Claude Code integration

JudgeLock can install project-shared Claude Code hooks that check writes before
`Edit` or `Write` and require a current passing receipt before Claude stops.

## Install

Install JudgeLock as an exact project dependency so every collaborator and the
generated hook launcher resolve the same CLI:

```sh
npm install --save-dev --save-exact judgelock@0.1.0
npx judgelock init
npx judgelock install claude-code
```

The installer merges two synchronous command hooks into `.claude/settings.json`:

- An `Edit|Write` `PreToolUse` hook calls
  `judgelock hook can-write --path <tool_input.file_path> --json`.
- A matcherless `Stop` hook calls `judgelock hook can-stop --json`.

Both settings entries use exec form with the real `node` executable and an
argument array. The generated `.claude/hooks/judgelock.cjs` launcher resolves
the local JudgeLock package and never invokes an npm command shim or a shell.
Malformed hook input, a missing CLI, a denied JudgeLock decision, and any other
nonzero CLI result all fail closed with Claude hook exit code 2.

The installer preserves unrelated settings and hooks, deduplicates JudgeLock
entries, and records the launcher hash in
`.judgelock/integrations/claude-code.json`. Before an install or uninstall
changes existing integration files, it saves their exact prior bytes and an
absence/hash manifest below `.judgelock/backups/claude-code/`. Re-running an
already-current install makes no backup and changes no file.

Do not hand-edit the generated launcher. Install and uninstall refuse to
overwrite or remove a launcher whose bytes no longer match JudgeLock's recorded
ownership hash.

## Uninstall

```sh
npx judgelock uninstall claude-code
```

Uninstall removes only the JudgeLock-owned hook handlers, launcher, and
ownership record. It preserves every unrelated Claude setting and hook.

## Security boundary and limitations

Claude Code hooks are cooperative guardrails, not a complete security boundary:

- The `Edit|Write` matcher does not intercept files changed through `Bash` or
  other tools.
- Stop hooks do not run when a turn ends because of an interrupt or API failure.
- Claude Code limits repeated Stop-hook blocking and may eventually override it.
- A user who can edit the repository can disable project hooks.

Run `judgelock inspect` and `judgelock verify` authoritatively, and enforce
`judgelock ci` in an independent, unprivileged pull-request workflow. The hook
structure follows the current
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks), and
project-shared settings use the documented
[`.claude/settings.json` scope](https://code.claude.com/docs/en/settings#configuration-scopes).
