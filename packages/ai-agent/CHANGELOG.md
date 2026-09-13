# Changelog

All notable changes to `@sigx/ai-agent` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- The contract: `Agent`, `AgentSession`, `AgentTurn`, `SessionOptions`,
  `SessionRef`, `TurnResult`, `PromptInput`.
- The event union (`AgentEvent`) with `(epoch, seq)` stamps, `AgentCapabilities`,
  `Decision`, `ToolAnnotations`, `ContentBlock`, `AgentError`, `SessionBusyError`.
- The policy engine: `resolveRequest` and the built-ins `allowAll`, `denyAll`,
  `allowReadOnly`, `allowTools`, `denyTools`, `firstMatch`, `rule`.
- Session helpers every adapter reuses: `createEventLog`, `createTurn`,
  `createSessionCore`, `createGrants`.
- `@sigx/ai-agent/testing`: `mockAgent`, a scripted agent.
- The transcript: `AgentTranscript`, `createTranscript`, the in-place, replayable
  `reduceAgentEvent` / `createReducer({ extensions })`; the bridges `toUIMessages`,
  `fromUIMessages`, `toChatStream`; the store seams `TranscriptStore` /
  `EventLogStore` with `memoryTranscriptStore` / `memoryEventLog`.
- `request-resolved` carries `permissionKey`, so a session grant replays without
  its request.
- `@sigx/ai-agent/testing`: `agentConformance`, `CONFORMANCE_SCENARIOS`,
  `CONFORMANCE_TOOLS` and the invariant checks `checkEventInvariants`,
  `checkReplayEquality`, `checkResultMatchesTurnEnd`.
- `@sigx/ai-agent/coding`: `CODING_CATEGORIES` / `categoryOf`, the typed
  `coding.diff` / `terminal` / `terminal-exit` / `plan` / `files-changed` events
  (`codingEvent`, `isCodingEvent`) with the `codingExtension` reducer plugin
  (`codingState`), `CodingSessionOptions`, the pure path helpers
  (`normalizePath`, `resolveFrom`, `isWithin`) and the policies
  `allowCategories` / `denyOutside`.
- `@sigx/ai-agent/testing`: `recordAgent` / `replayAgent` / `serializeFixture`
  — versioned, deterministic fixtures for any adapter.
- `@sigx/ai-agent/harness`: `createJsonRpcPeer` (JSON-RPC 2.0 over Web Streams,
  requests in both directions, cooperative cancel, backpressure), `ndjsonDecoder` /
  `ndjsonEncoder` and the `'message'` framing, `createMcpToolHandler` (client tools
  as an MCP Streamable HTTP server, JSON-only, tools only), `webSocketStreams`.
