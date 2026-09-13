# Changelog

All notable changes to `@sigx/ai-agent-codex` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- `codex({ command?, args?, env?, cwd?, transport?, passEnv?, clientInfo? })` —
  Codex as an `Agent` over `codex app-server`: threads as sessions
  (`resume: 'local'`, `fork`, `listSessions`), turns as prompts, approvals and
  questions through the session policy, `defineTool` tools as dynamic tools,
  structured output via `outputSchema`, `coding.*` extension events for
  commands, patches and plans, `config` from `model/list`.
- `thread/tokenUsage/updated` is reported under the well-known `Usage` keys
  every adapter shares instead of Codex's own spellings:
  `reasoningOutputTokens` → `reasoningTokens`, `cachedInputTokens` →
  `cacheReadInputTokens`, `cacheWriteInputTokens` → `cacheCreationInputTokens`.
- Steering (`steer: true`): `prompt()` while a turn runs is sent as
  `turn/steer` on the running Codex turn and shows up as a further
  `user-message` of that turn; the returned handle is the running turn's. A
  refused steer is a recoverable `error` inside the turn; one Codex answers
  after the turn already ended is a recoverable session-level `error`.
- Sub-agents (`subagents: 'observe'`): `collabAgentToolCall` items are
  `tool-call { name: 'collab/<tool>' }` / `tool-update`, a `spawnAgent`'s
  child thread an `agent-start { kind: 'subagent' }` bound to that call, and
  every change in the reported agent states an `agent-update` (one terminal
  per agent). `subAgentActivity` items update the thread they name,
  announcing it first when no collab call did. Running sub-agents are
  cancelled with an interrupted turn and when the session closes; otherwise
  they may outlive their turn. The `Thread` type carries `parentThreadId`,
  `source`, `agentNickname` and `agentRole`.

### Changed

- A prompt carrying a `file` or `resource` part is refused before any event
  (`promptParts: 'text+image'` is enforced by the session core) — the turn used
  to start, emit its `user-message`, and only then fail.

### Fixed

- `configure({ sandbox })` was recorded in the `config` event but never sent:
  the next `turn/start` now carries the matching `sandboxPolicy`.
- A `config` option's `current` is always one of its `values` — a granular
  approval policy or a sandbox we do not model (`externalSandbox`) is listed
  as its own value instead of pointing at nothing.
- `plan` items (and `item/plan/delta`) were passed through as `ext
  { name: 'item.plan' }` with their deltas dropped; they are text parts now.
  `coding.plan` stays the structured `turn/plan/updated` step list.
