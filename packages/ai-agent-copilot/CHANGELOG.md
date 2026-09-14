# Changelog

All notable changes to `@sigx/ai-agent-copilot` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- `copilot({ id?, client?, cliPath?, env?, cwd?, baseDirectory?, logLevel?,
  gitHubToken?, useLoggedInUser?, models?, errorSettleMs? })` — GitHub Copilot
  CLI as an `Agent` on the official `@github/copilot-sdk`: Copilot sessions as
  sessions (`resume: 'local'`, `listSessions`), `send()` … `session.idle` as a
  turn, message and reasoning deltas as parts, tool executions as `tool-call`
  / `tool-update` with `coding.terminal` for shell output, the runtime's
  permission asks (`shell`, `write`, `read`, `url`, `mcp`, `custom-tool`,
  `memory`, `hook`) and `ask_user` through the session policy, `defineTool`
  tools declared on the session and run in-process, `assistant.usage` as
  `usage` under the shared `Usage` keys, `subagent.*` as `agent-start` /
  `agent-update` with the sub-agent's own events nested under its spawning
  call, `session({ agents })` as `customAgents`.
- A switchable `model` config option from the runtime's model list (or
  `copilot({ models })`, the session's own model always offered) and a
  `reasoningEffort` option from what the model supports; `configure({ model,
  reasoningEffort })` calls `setModel` and re-announces the whole list.
- `copilot({ client })` injects a `CopilotClientLike` — the SDK's classes are
  checked against it, and tests script one.
