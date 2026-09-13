# Changelog

All notable changes to `@sigx/ai-agent-node` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/).

## [Unreleased]

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
