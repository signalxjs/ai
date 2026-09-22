# Changelog

All notable changes to `@sigx/json-ui` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

## [0.2.1] - 2026-09-22

### Changed

- Version bump in lockstep with `@sigx/ai-agent-claude-code` 0.2.1. No code change
  in this package.

## [0.2.0] - 2026-09-19

### Changed

- Peers on sigx core `^1.0.0` (`@sigx/reactivity`, `@sigx/runtime-core`);
  0.1.0 peered on `^0.15.0`. Core 1.0 promises additive minors, so the range
  is the major, and the app owns the single copy (rfc-1.0 §3).

## [0.1.0] - 2026-09-17

> First publish of `@sigx/json-ui` (published from `main` before this repo had tag-driven releases; no git tag).

### Added

- The package (proof of concept; born as `@sigx/ai-ui`, renamed before any release): a streamable JSON UI spec (`UISpec` /
  `UINode`), a safe JS-subset expression language (`{"$": "…"}` values and
  `{{…}}` interpolation, no `eval`), `defineCatalog` with the base catalog,
  `validateSpec` / `uiSpecSchema`, `specJsonSchema` and `describeCatalog` for
  the model, the `applyUIChunk` stream reducer with identity-preserving
  merges, the async action runtime (`state.*`, `http`, `delay`, `emit`,
  `call`, `seq`, `all`, `ui.patch`, host actions; `uiTool()` lives on
  `@sigx/ai/ui`), `UIView` / `createUIRuntime` on `@sigx/json-ui/app`, and the web
  component pack on `@sigx/json-ui/web`.
