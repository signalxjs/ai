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
  `claudeCodeAcp()` runs `claude-agent-acp`, the command installed by
  `@agentclientprotocol/claude-agent-acp` — the bridge moved out of
  `@zed-industries`, where `@zed-industries/claude-code-acp` is deprecated and
  installs the older `claude-code-acp`. `codexAcp()` keeps `codex-acp`; only
  the package to install changed, to `@agentclientprotocol/codex-acp`. Override
  `command` to stay on a deprecated bridge.
- Usage is reported under the well-known `Usage` keys every adapter shares
  instead of ACP's own spellings: `thoughtTokens` → `reasoningTokens`,
  `cachedReadTokens` → `cacheReadInputTokens`, `cachedWriteTokens` →
  `cacheCreationInputTokens`.
- The protocol subset as types (`Acp*`) with an assignability check against
  the reference SDK.

### Fixed

- `prompt(input, { output })` was silently ignored (the turn ended `end_turn`
  with no output); it now ends with `protocol_error` before anything is sent.
- Prompt parts outside the negotiated `promptParts` (an image for an agent
  without `promptCapabilities.image`, a file or resource without
  `embeddedContext`) were sent anyway; they are refused with `protocol_error`.
- `dispose()` closed the peer without closing the sessions: their logs never
  ended with `state: closed` and each session's MCP tools listener leaked.
- The agent process exiting mid-turn ended the turn `provider_error` while
  the session reported `process_exited`; both now say `process_exited`.
- The JSON-RPC peer no longer sends or honours `$/cancel_request` — not an
  ACP method; a turn is cancelled with `session/cancel` only.
- `listSessions()` returned the first page only; it follows `nextCursor`.
- `configure({ mode })` sent `session/set_mode` blindly; a session without
  modes, or an unknown mode id, now rejects with `protocol_error`.

### Changed

- The conformance run passes the negotiated capabilities, so every scenario
  the adapter cannot express is an asserted skip rather than a silent no-op.
