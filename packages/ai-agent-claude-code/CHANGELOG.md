# Changelog

All notable changes to `@sigx/ai-agent-claude-code` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

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
