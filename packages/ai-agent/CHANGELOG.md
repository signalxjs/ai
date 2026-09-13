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
- `@sigx/ai-agent/harness`: `createJsonRpcPeer` (JSON-RPC 2.0 over Web Streams,
  requests in both directions, cooperative cancel, backpressure), `ndjsonDecoder` /
  `ndjsonEncoder` and the `'message'` framing, `createMcpToolHandler` (client tools
  as an MCP Streamable HTTP server, JSON-only, tools only), `webSocketStreams`.
- `modelAgent({ model, tools?, system?, maxSteps?, store?, extensions? })` — our
  own engine as an `Agent`: every tool call through the policy, structured
  output on `turn.result.output`, resume through a `TranscriptStore` or a ref
  that carries the transcript, `importTranscript` from `UIMessage[]`.
- `agentTool(agent, { name, description, input, output?, prompt })` — an agent
  as a `defineTool` tool, with nested events (`parentCallId`) when hosted by
  `modelAgent`.
- `agentConformance` accepts `skip(scenario)` for reasons capabilities cannot
  express.
- `@sigx/ai-agent/wire`: the versioned envelope (`WireCommand`, `WireReply`,
  `WireFrame`, `WIRE_PROTOCOL_VERSION`), `serveSession` (idempotent commands,
  per-principal `authorize`, replay from the buffer, an `EventLogStore`, or a
  `gap`), `connectSession` (an `AgentSessionClient` that reconnects from its
  last cursor) and `coalesceFrames`.
