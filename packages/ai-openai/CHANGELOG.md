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
- User `image` / `file` parts become `input_image` / `input_file` content
  (URLs as given, inline base64 as data URLs, `filename` on files); an
  all-text message keeps the compact string form.
