# Changelog

All notable changes to `@sigx/ai-agent` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-09-19

### Changed

- Peers on sigx core `^1.0.0` (`@sigx/reactivity`, `@sigx/runtime-core`);
  0.1.0 peered on `^0.15.0`. Core 1.0 promises additive minors, so the range
  is the major, and the app owns the single copy (rfc-1.0 §3).
- The `@sigx/ai` peer range moves to `^0.2.0` — the family releases in
  lockstep, so upgrading one package means upgrading its siblings.

## [0.1.0] - 2026-09-17

> First publish of `@sigx/ai-agent` (published from `main` before this repo had tag-driven releases; no git tag).

### Added

- **Progressive tool input.** A `tool-input-delta` event carries a call's
  arguments as raw JSON text before its `tool-call`, which then settles the
  part they opened IN PLACE — one part per call, never two. `ToolPartState`
  gains `inputText` (the raw text) and the reducer-only `status: 'streaming'`
  (`ToolPartStatus`); `input` is the best partial read of the text, repaired
  structurally (`{"ci` is a dangling key and reads as `{}`), and is ABSENT
  when there is nothing to read at all — no text yet, or arguments that are
  not JSON — so `'input' in part` is the honest test. A `tool-call` that names
  no input settles the part with none, exactly as the non-streaming path. The
  text is capped at 100 000 characters, the same cap `applyChunk` uses, and
  the call still settles with the real input regardless. `toChatStream` maps
  it to the `tool-input` `UIChunk` `useChat` already renders, `toUIMessages`
  to a `streaming` `UIToolPart`, and `fromUIMessages` DROPS such a part — a
  call that was written but never made is not history.
- `AgentCapabilities.streamingToolInput` says whether an adapter carries
  those deltas. It is a statement about the adapter, not a promise about every
  call, so a client must never wait for a streaming part before showing a
  call. `modelAgent` and `@sigx/ai-agent-claude-code` declare it; ACP refines
  a call's input as a whole object rather than as appendable text, and the
  Codex app-server protocol has no argument deltas. `agentConformance` gains a
  `streaming-tool-input` scenario, which adapters declaring `false` skip with
  a printed reason, and `mockAgent`'s tool step gains `inputDeltas` to script
  them. `checkEventInvariants` holds a streamed `callId` to one turn — the id
  is spent even when the turn ended before the call was made, because the
  unsettled part is still in the transcript — and holds every delta and the
  settling `tool-call` to one `name`, since the deltas open the part with it
  and the settle does not rewrite it.
- COMPATIBILITY: `tool-input-delta` is a new member of the event union, so a
  `connectSession` client from an earlier version rejects the frame as
  unknown. It still reaches the right transcript when the `tool-call` lands
  and the cursor recovers on the next event, but pin client and server to the
  same version to see streaming input. `WIRE_PROTOCOL_VERSION` is unchanged —
  the envelope did not move.

- `modelAgent({ models })` — further `LanguageModel`s a session may run on
  besides the default. The session announces a `model` `ConfigOption` when it
  opens (so a late joiner replaying from `{ epoch: 0, seq: 0 }` sees it) and
  `configure({ model })` switches it from the next turn on, re-announcing the
  whole list. The choice belongs to the session, not the agent: two sessions
  of one agent can run different models. A `LanguageModel` carries its own
  `provider` and `modelId`, so the array is the whole catalogue — values are
  labelled `provider/modelId` and de-duplicated by id, default first.
  `MODEL_AGENT_CAPABILITIES.config` is `true`, and our engine now passes the
  `configure` conformance scenario.

- `createJsonRpcPeer({ requireVersion: false })` accepts incoming messages without the
  `"jsonrpc": "2.0"` member, for peers that speak JSON-RPC without it (`codex app-server`).
  A member other than `"2.0"` is still refused, and outgoing messages always carry it.
- `useAgentSession` shows and controls sub-agents: `view.agents` (the
  transcript's agents in start order), `view.agentTree` (the same as a tree)
  and `view.cancelAgent(agentId)` (fails into `error` without
  `subagents: 'control'`). A `prompt()` during a turn steers it when the agent
  has `steer`: `turn` stays the running turn, the promise resolves with its
  result, and `onTurnEnd` fires once per turn. The `app` entry re-exports the
  `AgentState` and `AgentNode` types.
- `agentConformance` gains four scenarios for sub-agents and steering:
  `delegate-tree` (`subagents: 'observe'` or `'control'` — one `agent-start`
  bound to an earlier `tool-call`, nested text under it, exactly one terminal
  `agent-update`, the call completed), `delegate-cancel` (`'control'` + `cancel`
  — `cancel({ agentId })` on the first `running` update ends that agent
  `cancelled` once while the turn goes on), `delegate-request` (`'control'` +
  `permissions: 'every-call'` — a request raised inside the sub-agent is
  answered through the host and resolved with the same `parentCallId`) and
  `steer` (`steer: true` — a second `prompt()` while the `delayed` tool runs
  resolves with the running turn's result under its id, with one `user-message`
  and an assistant part after it). `busy-session` asserts the same one-turn
  semantics on a steering agent. `needs: { subagents: 'observe' }` accepts
  `'control'`, like `resume: 'local'` accepts `'portable'`. `CONFORMANCE_TOOLS`
  gains `delayed` and the `delegate` / `delegateSlow` / `delegateAsking`
  sub-agents (`agentTool` over scripted `mockAgent`s; a native-tool harness
  scripts its own spawn).
- Steering and sub-agent control over the wire: a `cancel` command carries an
  optional `agentId` (`serveSession` answers `unsupported` for a sub-agent
  target unless the served capabilities say `subagents: 'control'` — the
  session's own id cancels the running turn like no target — and `invalid`
  for a malformed target; `connectSession`'s `cancel({ agentId })` sends it).
  A prompt during a running turn on a steering session joins that turn: the
  ack names the turn it went into and the client handle retargets to it —
  same `id`, same `result`, events from the steer's own `user-message` on,
  however far the transport lags — so a late joiner steers without ever
  having seen the running turn's `turn-start`. The wire conformance suite
  runs the steering mock and skips nothing.
- `modelAgent` runs agent definitions (`defineAgents: true`): `session({ agents })`
  turns each definition into a tool named after it (`{ task }` in, final text
  out) that runs a nested `modelAgent` — same model, the definition's `prompt`
  as system prompt, only the `tools` it names, `maxTurns` as step budget —
  through `agentTool`, governed the way the host session is (its `policy`,
  `interactive` and `requestTimeoutMs`); an invalid or colliding name, or a
  tool the session does not have or that a definition names twice, is refused
  at `session()` time. The definition's `model` is ignored (a harness alias).
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

- `modelAgent` honours `SessionOptions.model`, which it previously ignored:
  `session({ model })` opens on that model, and an id the agent does not offer
  is an `AgentError` rather than a silent fall back to the default. An
  `AgentDefinition.model` on a sub-agent is honoured the same way, except that
  an unknown id is *not* an error — a definition's model is a harness alias by
  contract, so the delegate stays on the session's model.
- Every `modelAgent` session emits a `config` event as its first event. A
  consumer that subscribes live (`subscribe()` with no cursor) misses it, as
  it would any event emitted before it subscribed; subscribe from
  `{ epoch: 0, seq: 0 }` for the whole log.

- `createJsonRpcPeer` no longer replies to an id-less message that lacks `"jsonrpc": "2.0"`.
  Such a message is notification-shaped, so nobody waits for a reply, and the old `id: null`
  error was a line the sender could not parse. It is reported through `onProtocolError`; a
  message that carries an id is still answered with -32600.
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

- `agentTool` namespaced the ids it forwards out of a delegate, so a delegate
  can no longer collide with the host. Ids are unique only within the session
  that minted them, and sequential ids are normal — two `mockModel`s both
  number their calls from `call_1`, a harness numbers its items per session —
  so a delegate's `call_1` used to land on the host's `call_1`: the host's own
  delegating call never settled, the delegate's updates resolved the wrong
  transcript part, and `checkEventInvariants` reported the reused `callId`.
  Every id on a forwarded event is now rewritten
  `<delegate session id>/<the delegate's own id>` — `callId`, `parentCallId`
  below the delegate, `agentId`, `requestId`, `messageId`, `partId` — and
  mapped back when `respond()` or `cancel({ agentId })` is routed into the
  delegate, which also stops either from reaching a delegate it was not
  addressed to. Unchanged: the delegate's own `agentId` on the `agent-start`
  bound to the call (the delegate session id, already host-space). Prefixes
  nest, one per level a grandchild's id travels up. **Ids inside a sub-agent
  are what the events say they are** — code that matched a delegate's id
  literally (a test, a UI keyed on a harness id) must read it off the event.
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
