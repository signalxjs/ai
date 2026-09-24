# Changelog

All notable changes to `@sigx/ai-agent-claude-code` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- `configure({ model })` between turns no longer opens an implicit turn that
  never ends (#193). Claude Code answers `setModel` with a local-command echo,
  a `user` frame reading `<local-command-stdout>Set model to …`, and no
  `result` after it. The adapter took that echo for the start of a turn the
  CLI runs by itself, so the session stayed `running` for good and every
  later `prompt()` was refused with `SessionBusyError`. A local-command echo
  is no longer turn content.

## [0.2.1] - 2026-09-22

### Fixed

- Permission requests in a turn Claude Code starts itself are no longer denied
  with "No turn is running." (#187). When a background task finishes, the CLI
  runs a model turn with no prompt. This mostly surfaced as `ExitPlanMode`
  failing in plan mode after a background sub-agent. Such a turn is now an
  **implicit turn**: a `turn-start` with an empty `input`, its events inside it
  instead of loose session-level `ext` frames, and a `turn-end` at the CLI's
  `result`. Requests in it go through the policy and `respond()`, `cancel()`
  interrupts it, and a `prompt()` meanwhile is refused with `SessionBusyError`,
  as behind any turn.
- A turn after a cancelled one no longer reads an `error_during_execution`
  result as `cancelled`. The interrupt flag is now reset per turn, not per
  query.

## [0.2.0] - 2026-09-19

### Changed

- Version bump in lockstep with `@sigx/ai` 0.2.0 — the workspace
  moves to sigx core `^1.0.0` (rfc-1.0 §3). No code change in this package.

## [0.1.0] - 2026-09-17

> First publish of `@sigx/ai-agent-claude-code` (published from `main` before this repo had tag-driven releases; no git tag).

### Added

- `streamingToolInput: true`. A call's arguments now reach the transcript as
  `tool-input-delta` events while the model writes them — the SDK's
  `input_json_delta` frames, which the adapter already buffered internally and
  only announced once assembled. The call itself is still announced exactly
  once, at `content_block_stop`, and settles the part the deltas opened. The
  deltas carry the MCP-stripped tool name, so they and the call agree, and a
  sub-agent's deltas carry its `parentCallId` like the rest of its events.

- Session option `thinking` (the SDK's `ThinkingConfig`), passed to
  `query()`, defaulting to `{ type: 'adaptive', display: 'summarized' }`. The
  adapter previously sent none, so every session ran on the SDK's default
  display (`omitted`) and every reasoning part came out empty. `null` sends no
  `thinking` at all and inherits Claude Code's own `thinking.display` /
  `--thinking-display` setting. Summaries are free — measured against the real
  CLI, `output_tokens` tracks `output_tokens_details.thinking_tokens`
  identically under both displays — and `adaptive` degrades gracefully on
  models that predate it (verified on Sonnet 4.5 and Haiku 4.5).
- A `thinkingDisplay` option on the `config` event (`summarized` / `omitted`,
  advertised whenever the session knows its display), switchable with
  `configure({ thinkingDisplay })` → `Query.setMaxThinkingTokens`, which
  carries the session's own thinking mode along so only the display changes.
  A session that advertises no `thinkingDisplay` (thinking disabled, or
  `thinking: null`) refuses the patch.
- `configOptions`, `resolveThinking`, `thinkingDisplayOf`, `thinkingBudgetOf`,
  `THINKING_DISPLAYS` and `DEFAULT_THINKING` are exported.
- Sub-agents. Claude Code's task frames (`system/task_started`,
  `task_progress`, `task_updated`, `task_notification`) and the Task tool's
  `tool_use_result` become `agent-start` / `agent-update`: one start per agent
  (`agentId` = the task id, `callId` = the spawning `tool_use_id`, `kind`
  `'subagent'` or `'workflow'`, `title`, `description`, `depth`, `background`)
  and exactly one terminal update, whichever frame ends the agent first. A
  foreground agent still running at `result` ends `failed` (`cancelled` after
  an interrupt); a background one ends when the session closes. Backgrounded
  Bash, MCP and ambient tasks stay `ext`. Capability `subagents: 'control'`.
- `cancel({ agentId })` → `Query.stopTask`; the `stopped` notification reads
  `cancelled`. A target that is already over is a no-op; one the CLI rejects
  is a `protocol_error`.
- `session({ agents })` → the SDK's programmatic `agents` (`description`,
  `prompt`, `tools`, `model`, `maxTurns`); capability `defineAgents: true`.
- Session options `subagentTranscript` (default `true`: the SDK's
  `forwardSubagentText`, so a sub-agent's text and thinking arrive as nested
  parts) and `agentProgressSummaries` (default `false`: model-written
  `summary` on progress updates).
- `createAgentTracker`, `taskKind` and `toAgentDefinitions` are exported.
- `createConfigState` and the `ConfigState` / `ConfigTracker` types are
  exported — the session's one source of truth for what it advertises.
- The `model` config option advertises a list to switch between instead of
  only the model the session is on: `CLAUDE_CODE_MODELS` (the `opus` /
  `sonnet` / `haiku` aliases the CLI resolves itself, plus the current full
  ids), exported, and replaceable per agent with `claudeCode({ models })` for
  a gateway, Bedrock / Vertex ids, or a model the default list leaves out. A
  session's own model is always offered too — `system/init` reports whatever
  the CLI resolved, and `ConfigOption.current` has to be one of `values`.

### Fixed

- A session advertised nothing until its first turn, and `configure()` before
  that threw `configure() needs a running session (prompt first)` — so a client
  rendering its controls from `view.config` had nothing to show and nothing to
  set until a turn had already run, and opening a session in plan mode and then
  prompting was not something a UI could offer. A session now announces
  `permissionMode` when it OPENS, resolved from the options it was opened with
  through the same `resolvePermissionMode` the query uses, so the advertised
  value and the value sent cannot drift — and `thinkingDisplay` alongside it
  whenever the session knows it, unchanged from before (a session opened with
  `thinking: null` or `{ type: 'disabled' }` advertises no display). `model` still
  waits for `system/init`: the CLI resolves aliases, settings and fallbacks, and
  it is the first honest word on which model is running. `configure()` before
  the first query records the patch and `toQueryOptions` folds it into that
  query rather than refusing it.
- A `configure()` the session had taken quietly evaporated when a query
  restarted — a `prompt(input, { output })` with a new output schema rebuilt
  its options from the session options alone. The recorded patch is now applied
  to every query the session starts.
- `configure()` announced only the settings it changed, so a client driving
  its controls off `transcript.config` lost the others until the next
  `system/init`: `configure({ permissionMode: 'plan' })` left a single-option
  list with no `model` and no `thinkingDisplay`. A `config` event is *the*
  options, not a patch of them — the reducer replaces the list wholesale — so
  the session now keeps its advertised settings in one place and both
  `system/init` and `configure()` emit the whole set.

### Changed

- The `actor` on a nested part is the sub-agent type Claude Code named
  (`Explore`, a custom agent name, …) when it is known; `'subagent'` otherwise.
- `steer` is declared `false` on purpose, with the reason in the README: the
  CLI, not the adapter, decides whether a mid-turn message folds into the
  running turn. The live suite carries a probe that records the behaviour.

- `claudeCode(options)` → an `Agent` on the official Claude Agent SDK: one
  `query()` per session with a streaming prompt, turns ending at `result`,
  permissions through the session policy (`canUseTool`), client tools over
  MCP (`createMcpToolHandler` + `listenMcp`), spawning through
  `@sigx/ai-agent-node`, resume / fork / `listSessions`, structured output,
  `configure({ model, permissionMode })`, `coding.diff` / `coding.plan` for
  the built-in edit and todo tools.
- `AskUserQuestion` reaches the client as `request { kind: 'input' }` with a
  schema (one property per question, multi-select as an array, free-text
  "Other" allowed) and the options flattened, instead of an Allow/Deny
  permission over the whole tool call. `respond(id, { type: 'input', answers })`
  sends the answers back to the model through `canUseTool`'s `updatedInput`,
  so an answered question is recorded as answered, never as a denial.
  `ASK_USER_QUESTION`, `parseQuestions`, `questionId`, `questionsSchema`,
  `questionOptions`, `questionsMessage` and `toAskAnswers` are exported for
  clients that want to render or replay the same shape.
- Redacted thinking is visible without knowing the namespace. Claude Code does
  not expose thinking TEXT: it streams `thinking_delta`s carrying `''` and
  reports progress on its own `system/thinking_tokens` frames. An empty delta
  is no longer emitted as a `part-delta` (the same guard applies to
  `text_delta`), so a thinking block costs frames only when it says something;
  and every progress frame now also goes out as `usage { scope: 'turn',
  usage: { reasoningTokens } }` — turn-scope usage is additive and
  `estimated_tokens_delta` is the increment, so the well-known
  `Usage.reasoningTokens` key grows live while the block runs and any client
  can show "thinking…". The raw frame still ships as
  `ext { ns: 'claude-code', name: 'thinking_tokens' }`. The streamed figure is
  the CLI's own estimate; the billed count (`usage.output_tokens_details
  .thinking_tokens`, and `modelUsage[].thinkingTokens` for the session) now
  lands on `turn-end` and on the session-scope `usage`, which assign and so
  supersede it — it is deliberately left off the turn-scope event at `result`,
  which would add it a second time.
