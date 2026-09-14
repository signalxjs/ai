# Changelog

All notable changes to `@sigx/ai-agent-claude-code` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

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
