# Changelog

All notable changes to `@sigx/ai-anthropic` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- `anthropic({ apiKey?, client?, defaultOptions? })` → `.model(id)`: a
  `LanguageModel` on `@anthropic-ai/sdk` — streaming, tool use (parallel
  calls, `strict`), adaptive thinking with signed-block replay, `refusal`
  and `max_tokens` stop reasons, usage. `providerOptions` passthrough.
