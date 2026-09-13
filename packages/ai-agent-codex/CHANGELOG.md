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
- `thread/tokenUsage/updated`'s `reasoningOutputTokens` is reported as
  `usage.reasoningTokens`, the well-known `Usage` key every adapter uses for
  the reasoning breakdown, instead of Codex's own spelling.
