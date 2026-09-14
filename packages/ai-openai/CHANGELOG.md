# Changelog

All notable changes to `@sigx/ai-openai` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- `openai({ apiKey?, client?, defaultOptions? })` → `.model(id)`: a
  `LanguageModel` on the `openai` SDK's Responses API — streaming text and
  reasoning summaries, function calling (parallel, `strict`), JSON schema
  output, usage. `providerOptions` passthrough.
- A function call's arguments stream: `response.function_call_arguments.delta`
  becomes a `tool-input-delta` carrying the call id AND the function name, so
  the UI can label the call before it is assembled.
- User `image` / `file` parts become `input_image` / `input_file` content
  (URLs as given, inline base64 as data URLs, `filename` on files); an
  all-text message keeps the compact string form.
