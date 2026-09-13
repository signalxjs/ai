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
