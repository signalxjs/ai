# Changelog

All notable changes to `@sigx/ai` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Added

- The provider-neutral core: the `LanguageModel` seam, `UIMessage` / `UIPart`
  and the `UIChunk` stream protocol, `defineTool` (Standard Schema input,
  JSON Schema for the wire), and the engine — `streamText`, `generateText`,
  `streamObject`, `generateObject` — running the tool loop once for every
  provider. Zero dependencies, `node:`-free.
- `@sigx/ai/app`: `useChat`, `useCompletion`, `useObject` — composables on
  `@sigx/runtime-core`. A streaming text delta is one property write on one
  part of a reactive transcript.
- `@sigx/ai/server`: `chatStream` for `serverStream` handlers, `toTextStream`
  for `useStream`, and `ChatInput`, a dependency-free Standard Schema for the
  wire transcript.
- `@sigx/ai/testing`: `mockModel`, a scripted deterministic model.
