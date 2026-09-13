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
- `Usage` documents its well-known extra keys — `reasoningTokens` (of
  `outputTokens`, how many were reasoning: a breakdown, never an addition),
  `cacheReadInputTokens` / `cacheCreationInputTokens` and `totalTokens` — so
  every provider and agent adapter reports the same number under the same name
  and a client can read it without knowing which one produced it. The index
  signature stays open; no type change.
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
- Steering. `streamText({ steer })` takes a `() => readonly ModelUserMessage[]` the
  engine polls between model rounds — after a round's tool results, and when a
  round answered without tool calls; a non-empty result is appended and the
  model is asked again. Rounds count against `maxSteps` (a steer on the last
  round ends the turn with `finish { reason: 'length' }`); nothing is yielded
  for the injected messages. `generateText` passes it through.
- Image and file parts on user messages: `UIImagePart` / `UIFilePart`
  (`mediaType` plus exactly one of `data` — standard base64 — or `url`, and an
  optional `filename` on files), passed through by `toModelMessages` as
  `ModelImagePart` / `ModelFilePart` (an all-text message stays a string),
  validated by `ChatInput` (media type, base64, http(s) URL, size caps, user
  messages only), accepted by `useChat.send`. `encodeBase64` / `decodeBase64`
  for the bytes, `Buffer`-free.
