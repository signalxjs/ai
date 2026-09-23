# Changelog

All notable changes to `@sigx/ai-agent-acp` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.2.1] - 2026-09-22

### Changed

- Version bump in lockstep with `@sigx/ai-agent-claude-code` 0.2.1. No code change
  in this package.

## [0.2.0] - 2026-09-19

### Changed

- Version bump in lockstep with `@sigx/ai` 0.2.0 — the workspace
  moves to sigx core `^1.0.0` (rfc-1.0 §3). No code change in this package.

## [0.1.0] - 2026-09-17

> First publish of `@sigx/ai-agent-acp` (published from `main` before this repo had tag-driven releases; no git tag).

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
- `copilotAcp()` — GitHub Copilot CLI's own ACP server (`copilot --acp`,
  public preview) as a preset, passing `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
  `GITHUB_TOKEN` and `COPILOT_HOME`. The full-fidelity adapter on the
  official SDK is `@sigx/ai-agent-copilot-cli`.
- The protocol subset as types (`Acp*`) with an assignability check against
  the reference SDK.

### Fixed

- A session mode and an agent-declared config option could both be advertised
  as `mode`, and the second was unreachable: `configure()` routed on the
  literal key, so every attempt to set the agent's option called
  `session/set_mode` instead — two controls, one silently driving the other.
  `toConfigOptions` is now `toConfigView`, which returns the options **and**
  where each one came from, and `configure()` dispatches on that origin. The
  session mode keeps the `mode` id (it is what `configure({ mode })` has
  always meant); a colliding agent option is namespaced to `acp:mode`, and
  when both would render as "Mode" it is our own label that becomes
  "Session mode". An agent that does not collide is unaffected. Consequences:
  `session/set_config_option` now carries the agent's own `configId` rather
  than the id we advertised; `configure({ mode })` on a session with no modes
  but a `mode` config option works instead of throwing; and an unknown key is
  now refused with the list of what the session does advertise, replacing the
  `has no modes to set` message.
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
