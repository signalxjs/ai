# Changelog

All notable changes to `@sigx/ai-agent-node` are documented here. The format
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

> First publish of `@sigx/ai-agent-node` (published from `main` before this repo had tag-driven releases; no git tag).

### Added

- `buildChildEnv` and `DEFAULT_ENV_ALLOWLIST` — an allowlisted child
  environment (case-insensitive on Windows, `NODE_OPTIONS` never inherited).
- `resolveExecutable` — `PATH` / `Path`, `PATHEXT`, JS entries under
  `process.execPath`, npm/pnpm `.cmd` shims parsed to their script
  (`parseCmdShim`); `ExecutableNotFoundError`.
- `spawnAgentProcess` — Web Streams stdio with backpressure, stderr tail,
  `cmd.exe /d /s /c` fallback with strict quoting (`UnsafeArgumentError` for
  `%`), `kill()` of the whole tree (process group / `taskkill /T`);
  `ProcessExitedError`; children die with the parent (`registerChild`,
  opt-in `installSignalForwarding`).
- `listenMcp` — a loopback `node:http` host for a `(Request) => Promise<Response>`
  handler behind a bearer token.
