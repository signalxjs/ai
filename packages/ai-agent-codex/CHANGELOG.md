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
- Sub-agents (`subagents: 'control'`): `collabAgentToolCall` items are
  `tool-call { name: 'collab/<tool>' }` / `tool-update`, a `spawnAgent`'s
  child thread an `agent-start { kind: 'subagent' }` bound to that call, and
  every change in the reported agent states an `agent-update` (one terminal
  per agent). `subAgentActivity` items update the thread they name; a
  `started` activity for a thread not yet seen is the spawn itself, as Codex
  0.154 reports it (a `collab/spawnAgent` call under the activity's id).
  Running sub-agents are cancelled with an interrupted turn and when the
  session closes; otherwise they may outlive their turn. The `Thread` type
  carries `parentThreadId`, `source`, `agentNickname` and `agentRole`.
- Sub-agent threads are routed to the session that spawned them (verified live
  against Codex CLI 0.154, #100): their turns stream as parts and tool calls
  nested under the spawn call and spoken by the agent, frames that arrive
  before the activity naming the child are held and replayed, their requests
  go through the session policy with the same `parentCallId`, and their token
  usage is reported as `agent-update.usage` instead of the host's totals.
  `cancel({ agentId })` interrupts the child's running turn (or its next one,
  when it has none yet) and ends the agent `cancelled` when that turn does; a
  finished or unknown agent is refused with `protocol_error`.

### Changed

- A prompt carrying a `file` or `resource` part is refused before any event
  (`promptParts: 'text+image'` is enforced by the session core) — the turn used
  to start, emit its `user-message`, and only then fail.

### Fixed

- The adapter connects to a real `codex app-server`. The server omits the `jsonrpc` member on
  everything it sends and the JSON-RPC peer dropped those messages, so `initialize` never
  settled and `session()` hung; the peer now opens with `requireVersion: false` (#126). The
  test fake speaks the same dialect, so the suite exercises what Codex actually sends.
- `configure({ sandbox })` was recorded in the `config` event but never sent:
  the next `turn/start` now carries the matching `sandboxPolicy`.
- A `config` option's `current` is always one of its `values` — a granular
  approval policy or a sandbox we do not model (`externalSandbox`) is listed
  as its own value instead of pointing at nothing.
- `plan` items (and `item/plan/delta`) were passed through as `ext
  { name: 'item.plan' }` with their deltas dropped; they are text parts now.
  `coding.plan` stays the structured `turn/plan/updated` step list.
