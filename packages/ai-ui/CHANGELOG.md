# Changelog

All notable changes to `@sigx/ai-ui` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Added

- The package (proof of concept): a streamable JSON UI spec (`UISpec` /
  `UINode`), a safe JS-subset expression language (`{"$": "…"}` values and
  `{{…}}` interpolation, no `eval`), `defineCatalog` with the base catalog,
  `validateSpec` / `uiSpecSchema`, `specJsonSchema` and `describeCatalog` for
  the model, the `applyUIChunk` stream reducer with identity-preserving
  merges, the async action runtime (`state.*`, `http`, `delay`, `emit`,
  `call`, `seq`, `all`, `ui.patch`, host actions), `uiTool()` for the tool
  loop, `UIView` / `createUIRuntime` on `@sigx/ai-ui/app`, and the web
  component pack on `@sigx/ai-ui/web`.
