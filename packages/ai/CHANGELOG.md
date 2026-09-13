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
- Tool approval. `defineTool({ needsApproval, annotations })` flags a call
  that needs a human (always, or per validated input); `streamText` yields a
  `tool-approval-request` chunk and asks `onToolApproval`, which answers
  `'allow'`, `'deny'` / `{ deny: reason }` or `'defer'`. A denied call is a
  `tool-result` with `denied: true` the model sees as an error; without a
  handler a gated call is denied, never silently run. `UIToolState` gains
  `awaiting`, `approved` and `denied`. `chatStream` defers by default and
  `streamText` resumes a transcript whose last assistant message carries the
  client's decisions, so a stateless `serverStream` can ask the user:
  `useChat` exposes `status: 'awaiting'`, `approvals`, `approve(id)` and
  `deny(id, reason?)`. A client's approval is re-checked by `onToolApproval`
  (`ctx.approvedByClient`), so a server handler can veto it.
- Structured output inside the tool loop. `streamText({ output: { schema,
  jsonSchema?, name? } })` asks every model round for the JSON format (tools
  still run) and validates the final answer onto `finish.output`; a final
  answer that does not parse or validate is one `error` chunk. `generateText`
  returns a typed `output`; `useChat.onFinish` receives it. A turn ending on
  the token limit, a refusal or a deferred approval carries no output.
