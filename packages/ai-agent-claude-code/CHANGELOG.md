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
