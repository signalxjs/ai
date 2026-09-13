# Changelog

All notable changes to `@sigx/ai-agent-acp` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- `acp(options)` — every Agent Client Protocol agent as an `@sigx/ai-agent`
  `Agent`: `initialize` → honest capabilities (`connect()`), `session/new` /
  `resume` / `load` / `fork` / `list`, `session/prompt` mapped onto turns
  (text and thought chunks, tool calls and updates, diffs and plans as
  `coding.*` events, usage, modes and config), `session/request_permission`
  through the policy, `session/cancel`, client tools over HTTP MCP.
- Opt-in client methods: `fs/read_text_file`, `fs/write_text_file` (fenced to
  the session roots and gated by the policy) and `terminal/*` (through
  `spawnAgentProcess`).
- Presets: `gemini()`, `cursor()`, `claudeCodeAcp()`, `codexAcp()`.
- The protocol subset as types (`Acp*`) with an assignability check against
  the reference SDK.
