# Claude Code integration

JudgeLock installs deterministic project-shared Claude Code hooks without
treating every normal response as a completion claim.

The hook contract was checked against the official
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks) and
[settings documentation](https://code.claude.com/docs/en/configuration) on
2026-07-14. Claude Code behavior is version-sensitive; use `/hooks` and
`/status` to inspect the effective configuration after upgrades.

## Safe default installation

Install JudgeLock as an exact project dependency, then install the hooks:

```sh
npm install --save-dev --save-exact judgelock@0.1.0-beta.1
npx judgelock init
npx judgelock install claude-code
```

The default installer merges two command-hook groups into
`.claude/settings.json`:

- `PreToolUse` with matcher `Edit|Write` calls the generated launcher’s
  `can-write` action. Exit 2 blocks the tool call.
- Matcherless `TaskCompleted` calls `judgelock hook can-stop --json`. Exit 2
  prevents an explicit Claude Code task from being marked complete.

`TaskCompleted` fires for explicit task completion, not for every assistant
response. This allows Claude to ask clarification questions, report partial
progress, wait for user input, end a normal non-completion response, and recover
from failed or interrupted validation without a Stop-hook loop.

The `PreToolUse` payload must identify `hook_event_name: "PreToolUse"`, an
`Edit` or `Write` tool, and a string `tool_input.file_path`. The `TaskCompleted`
payload must identify its event and provide `task_id` and `task_subject`.
Malformed or mismatched payloads fail closed with exit 2.

## Opt-in autonomous Stop mode

For an autonomous, single-task session where every normal response is intended
to represent final completion, install the additional Stop gate explicitly:

```sh
npx judgelock install claude-code --autonomous-stop-hook
```

The matcherless `Stop` hook checks `hook can-stop`. The launcher validates the
current Stop schema, accepts `last_assistant_message` only as an uninterpreted
string, and never uses an LLM or textual heuristic to decide whether the message
“sounds complete.” If `stop_hook_active` is true, the launcher allows the Stop
without invoking JudgeLock so a repeated denial cannot trap the conversation.
Claude Code independently overrides a Stop hook after eight consecutive blocks.

Running the installer again without `--autonomous-stop-hook` removes only the
JudgeLock-owned Stop handler and returns to the safe default. Repeating either
mode is idempotent.

## Launcher and settings behavior

Hook settings invoke `node` with an argument array. The generated CommonJS
launcher resolves the project-local JudgeLock package and invokes its CLI with
`process.execPath`, no npm shim, and no shell. This works on native Windows and
POSIX systems without command-string quoting.

Claude settings from project, local, user, and managed scopes are combined by
Claude Code; matching hooks from different sources all run. Within the shared
project settings file, JudgeLock preserves unrelated settings and hook groups,
removes only handlers with its exact launcher arguments, and appends its owned
groups. One hook denial does not prevent sibling hooks from running.

Before changing existing settings or launcher bytes, installation and
uninstallation save an exact backup and manifest below
`.judgelock/backups/claude-code/`. Ownership state records the launcher hash and
whether autonomous Stop mode is enabled. JudgeLock refuses to overwrite or
delete a launcher changed after installation.

## Uninstall

```sh
npx judgelock uninstall claude-code
```

Uninstall removes only JudgeLock-owned handlers, launcher, and ownership state.
It preserves unrelated hooks and settings and is idempotent.

## Security boundary

Pre-write hooks are cooperative early feedback, not a filesystem sandbox. The
`Edit|Write` matcher does not intercept arbitrary Bash commands, other tools, or
external processes. Stop hooks do not inherently mean task completion and do not
run for every interrupt or API failure. Project hooks can also be disabled by
someone who controls the repository.

Run `judgelock inspect` and `judgelock verify` authoritatively, and enforce
`judgelock ci` in independent, unprivileged pull-request CI.
