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
- A tool call's arguments stream: `input_json_delta` becomes a
  `tool-input-delta` carrying the block's id AND its tool name, so the UI can
  label the call before it is assembled.
- User `image` parts become `image` blocks (base64 for JPEG/PNG/GIF/WebP, or
  a URL source) and `file` parts become `document` blocks (base64 PDF, plain
  text as a text source, or a URL source) with `filename` as the title. An
  unsupported media type is refused at request time with a clear error.
