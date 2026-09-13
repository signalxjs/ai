# Changelog

All notable changes to `@sigx/ai-agent` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Steering and sub-agent control over the wire: a `cancel` command carries an
  optional `agentId` (`serveSession` answers `unsupported` unless the served
  capabilities say `subagents: 'control'`, `invalid` for a malformed target;
  `connectSession`'s `cancel({ agentId })` sends it). A prompt during a
  running turn on a steering session joins that turn: the ack names the turn
  it went into and the client handle retargets to it — same `id`, same
  `result`, events from the steer on — so a late joiner steers without ever
  having seen the running turn's `turn-start`. The wire conformance suite
  runs the steering mock and skips nothing.

- `mockAgent`: an `agent` step (`MockAgentStep`) spawns a sub-agent — the
  spawning `tool-call` through the policy, `agent-start` bound to it, the
  nested `steps` played under the call with `parentCallId` (nested requests
  answered through the session, nested `usage` on the agent's terminal
  `agent-update`), and `cancel({ agentId })` cancelling that one agent while
  the turn continues. A `steer` option scripts the reply to steering input,
  which plays in a new assistant message before the next step (default: one
  line of text). With `subagents: 'none'` an `agent` step runs as a plain
  tool call.
- `recordAgent` / `replayAgent` record a targeted cancel (`FixtureCommand`
  `cancel.agentId`) and a steer (a prompt into the running turn), and replay
  both.
- `modelAgent` steers (`steer: true`): a prompt during a turn is a
  `user-message` in that turn and reaches the model at the engine's next round
  boundary (`streamText`'s `steer`), answered in a second assistant message;
  what the engine never drains stays in the transcript for the next turn.
- `modelAgent` controls its sub-agents (`subagents: 'control'`): `agentTool`
  emits `agent-start` (bound to the calling tool call; `title` option) and
  `agent-update` — running, the delegate's own cumulative usage, and exactly one
  terminal status — attaches the delegate session so the host's `respond()`
  answers a request raised inside it and `cancel({ agentId })` stops it, and
  forwards a nested delegate's agent events so a grandchild sits one level
  deeper in `agentTree`. The tool context `modelAgent` hands its tools gains
  `attach(downstream)`.
- The sub-agent tree in the transcript: `transcript.agents` (`AgentState` by
  id, folded from `agent-start` / `agent-update` — status, cumulative usage,
  output, the spawning `callId`, and `depth` / `parentAgentId` derived from the
  call chain), `ToolPartState.agentId` on the spawning tool part, and the
  selectors `spawnedAgent`, `callerAgent`, `childAgents`, `agentMessages`,
  `agentTree`, `walkAgents`, `agentsUsage`. `checkEventInvariants` now holds
  every agent to one start, a seen spawning call bound to no other agent (and,
  when nested, nested under that very call), and a terminal status — and every
  `tool-call` to a fresh `callId`.
- `toUIMessages(transcript, { subagents: 'flatten' | 'omit' })` — `omit` drops
  the messages produced inside a sub-agent (the default flattens them as
  before), and `promptPartsToUI` exposes the user half of the mapping.
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
- `ReasoningPartState.done` — set by `part-end`. A harness may redact reasoning
  TEXT while still opening a real reasoning part, so empty text alone cannot
  tell a block that is still thinking from one that thought and showed nothing;
  a view needs both to render a "thinking…" affordance only while it is true.
- The well-known `Usage` keys every adapter reports under the same name,
  `reasoningTokens` first among them, are documented on `Usage` in `@sigx/ai`
  and in this package's README.
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
- `@sigx/ai-agent/app`: `useAgentSession(source, options?)` — an `AgentSession`
  (local or a `connectSession` client) as reactive state on `@sigx/runtime-core`:
  `transcript`, `messages`, `state`, `turn`, `requests`, `usage`, `costUsd`,
  `config`, `error`, `live`, `capabilities`, and the actions `prompt`,
  `respond`, `cancel`, `configure`. Folds in place (a `part-delta` writes one
  part's `text`), subscribes on mount (SSR-safe), unsubscribes on unmount
  without closing the session — and after unmount writes no state and fires no
  callback, however late an action settles — replays from `{ epoch: 0, seq: 0 }` so a late
  joiner catches up, and takes the same `extensions` the headless reducer does.
  Peers on `@sigx/reactivity` and `@sigx/runtime-core`; the other entries do
  not.
- `modelAgent`: `session({ resume, fork: true })` — a new session over a copy
  of the transcript (`fork: true`); `pricing(usage)` reports `costUsd` on the
  `usage` event, `turn.result` and the transcript.
- `createSessionCore({ promptParts })` fails a prompt carrying a part beyond
  the declared level before any event is emitted; `mockAgent` and `modelAgent`
  pass theirs.
- `agentConformance`: ten more scenarios — `session-grant`, `request-timeout`,
  `configure`, `fork`, `list-sessions`, `late-join`, `portable-resume`,
  `prompt-after-close`, `respond-unknown`, `usage` (twenty-one in all). A
  scenario may carry its own `sessionOptions` (a short `requestTimeoutMs`);
  `checkEventInvariants(events, { fromStart: true })` requires every epoch to
  start at seq 1, which `late-join` holds a replay from `{ epoch: 0, seq: 0 }`
  to.
- `mockAgent` declares `fork` and `listSessions` and lists every session it
  opened; `recordAgent` records `listSessions()` results
  (`AgentFixture.listSessions`) and `replayAgent` replays them in order.
- `@sigx/ai-agent/wire`: `AgentSessionClient.status` (`connecting` /
  `connected` / `reconnecting` / `lost` / `closed`), `onStatusChange(listener)`
  and `reconnect()`; `RemoteCommandError` (an `AgentError` with `command` and
  the wire code as `remote`) for a command the server refused; `serveSession`
  validates each command payload's shape and answers `invalid` before it
  reaches the session.
- `@sigx/ai-agent/app`: `view.connected` and `view.reconnect()`; a lost
  connection lands in `error` as a recoverable `protocol_error` (and
  `onError`), and a subscription that ends while the session is still open is
  reported the same way. A clean close stays silent.
- Sub-agents in the contract: `agent-start { agentId, callId?, kind?, title?,
  description?, model?, depth?, background? }` and `agent-update { agentId,
  status: AgentStatus, summary?, usage? (cumulative), costUsd?, output?, error? }`
  join the event union — a spawn is always a call, and a sub-agent's events
  nest under the spawning call's `parentCallId`. The capabilities `subagents:
  'none' | 'observe' | 'control'` and `defineAgents`, `SessionOptions.agents`
  (`AgentDefinition`), and `cancel(target?: CancelTarget)` — `{ agentId }`
  cancels one sub-agent (`subagents: 'control'`).
- `createSessionCore` owns steering and sub-agent control: `ctx.onSteer(handler)`
  receives steering input (queued until registered), `core.steer(input)` returns
  a handle to the RUNNING turn, `core.attach(downstream)` forwards `respond()`
  and addressed `cancel()` to a delegate session (both only with `subagents:
  'control'`), and `ctx.resolve(request, { parentCallId })` stamps a request a
  sub-agent raised.

### Changed

- `coalesceFrames` merges a sub-agent's nested `part-delta` frames too — within
  one part and nesting level, never across; before, nested deltas always
  passed through one by one. A remote turn handle's `id` is now a getter: it
  changes once when the ack names a different turn (a steer).
- `MOCK_CAPABILITIES` now declares `steer: true` and `subagents: 'control'`;
  a test that relied on the mock rejecting a prompt during a turn passes
  `capabilities: { steer: false }`.
- `agentTool` no longer forwards a delegate's `usage` events into the host
  turn: they were summed into the host session's totals. The delegate's usage
  now rides on its `agent-update` and lands on `transcript.agents[id].usage`.
- With the `steer` capability, `prompt()` while a turn runs now injects into
  the running turn instead of starting a concurrent second turn: the returned
  turn has the running turn's `id` and `result` and iterates its events from
  the steer on. Without `steer`, it still rejects with `SessionBusyError`.
- `connectSession` reconnect defaults: 10 attempts with exponential backoff
  from 250 ms capped at 10 s (was 5 attempts at `100 * n` ms, ~1.5 s in all).
  Exhausted attempts — or `reconnect: false` after a break — leave the client
  `lost` with its buffer open and pending turns waiting for `reconnect()`;
  before, the buffer closed and pending turns rejected. `disconnect()` /
  `close()` still end everything.

### Fixed

- `modelAgent` fed a delegate's flattened text back to the host model as the
  host's own words on the next turn; it now builds the conversation with
  `toUIMessages(transcript, { subagents: 'omit' })`.
- Session grants survive resume: `modelAgent` and `mockAgent` seed the session
  from the transcript's (or the ref's) grants, so a tool allowed for the session
  is not asked again after `resume`.
- `mockAgent` honours `importTranscript` (`ref.data.messages` is replayed into
  the log through `fromUIMessages`) and its `cancel()` is a no-op without the
  `cancel` capability.

### Removed

- `SessionOptions.raw` / `EventContext.raw` — declared, never produced by any
  agent; vendor detail travels as JSON under `error.data` / `ext.data`.
