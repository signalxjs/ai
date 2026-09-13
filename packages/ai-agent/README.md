# @sigx/ai-agent

> **Experimental** — 0.x, the contract may still move until three independent
> adapters pass the conformance suite.

The agent layer for [`@sigx/ai`](https://www.npmjs.com/package/@sigx/ai): one
provider-neutral `Agent` contract that drives agent harnesses (Claude Code,
Codex, every Agent Client Protocol agent) **and our own engine**, so an app, a
CLI, a CI job or a server is written once and runs against any of them. A
session is a gapless log of plain-JSON events; a policy decides what a tool
may do; capabilities say what an adapter really delivers. Zero dependencies,
no `node:` imports — Node, workerd and the browser alike.

```ts
import { modelAgent, allowReadOnly } from '@sigx/ai-agent';
import { anthropic } from '@sigx/ai-anthropic';

// Our own engine as an agent — any LanguageModel, any runtime, no process.
const agent = modelAgent({ model: anthropic().model(), tools: [search, lookup] });
const session = await agent.session({ interactive: false, policy: allowReadOnly });
const turn = session.prompt('Summarise the open incidents.');
let text = '';
for await (const event of turn) {
    if (event.type === 'part-delta') text += event.delta;
}
const { stopReason } = await turn.result; // 'end_turn'
```

Six entries today (more land with the following milestones):

| Entry | What |
|---|---|
| `@sigx/ai-agent` | the contract (`Agent`, `AgentSession`, `AgentTurn`), the event union, capabilities, the policy engine (`resolveRequest`, `allowAll`, `allowReadOnly`, `firstMatch`, …), the session helpers adapters build on (`createEventLog`, `createTurn`, `createSessionCore`), the transcript reducer (`reduceAgentEvent`, `createReducer`) with its bridges to `@sigx/ai` (`toUIMessages`, `fromUIMessages`, `toChatStream`), the store seams (`TranscriptStore`, `EventLogStore`), `modelAgent` (our engine as an agent) and `agentTool` (an agent as a tool) |
| `@sigx/ai-agent/coding` | the coding vocabulary on top of the neutral core: categories (`read`, `edit`, `execute`, …), typed `coding.diff` / `terminal` / `plan` / `files-changed` events with the `codingExtension` reducer plugin, `CodingSessionOptions`, and the path-aware policies `allowCategories` / `denyOutside(cwd)` |
| `@sigx/ai-agent/harness` | the protocol kit: `createJsonRpcPeer` (JSON-RPC 2.0 over Web Streams, both directions), NDJSON framing, `createMcpToolHandler` (client tools as an MCP server, Streamable HTTP), `webSocketStreams` |
| `@sigx/ai-agent/wire` | `serveSession` / `connectSession` — a session served in one place and used from another over any transport, with a versioned envelope and replay for late joiners and reconnects |
| `@sigx/ai-agent/app` | `useAgentSession(source)` — the session as reactive state on `@sigx/runtime-core`: transcript, open requests, usage, config, and the `prompt` / `respond` / `cancel` / `configure` actions |
| `@sigx/ai-agent/testing` | `mockAgent` — a scripted, deterministic agent — `agentConformance`, the suite every adapter must pass, and `recordAgent` / `replayAgent` for deterministic fixtures |

## Sub-agents and steering

A sub-agent is observed and controlled through the same contract as the
session that spawned it. **A spawn is always a call**: the `tool-call` that
started the sub-agent is the anchor, `agent-start` binds an `agentId` to it,
and every event the sub-agent produces carries that call as `parentCallId`.

```
tool-call     { callId: 'c1', name: 'delegate' }
agent-start   { agentId: 'a1', callId: 'c1', kind: 'reviewer', title?, description?, model?, depth?, background? }   parentCallId: 'c1'
agent-update  { agentId: 'a1', status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled', summary?, usage?, costUsd?, output?, error? }
part-start … tool-call … request …                                                                                  parentCallId: 'c1'
```

`agent-update.usage` is cumulative for that agent (it replaces, never adds).
Exactly one `agent-start` per `agentId`; every started agent reaches a
terminal status before the session closes. `callId` is absent only for an
ambient task a harness started on its own — such an agent has status and usage
but no message attribution.

Two capabilities say what an adapter really delivers:

- `subagents`: `'none'` (no agent events), `'observe'` (the events above),
  `'control'` (also `session.cancel({ agentId })`, and `session.respond()`
  answers a `request` raised at any depth).
- `defineAgents`: `session({ agents: { reviewer: { description, prompt?, tools?, model?, maxTurns? } } })`
  makes those definitions spawnable by name.

`cancel(target?)` takes one verb for both: no target (or the session's own
id) cancels the running turn; `{ agentId }` cancels one sub-agent and is
refused with `protocol_error` unless `subagents` is `'control'`.

**Steering.** With the `steer` capability, `prompt()` while a turn runs does
not start a second turn — the input is injected into the RUNNING turn. The
returned turn has the running turn's `id` and `result`, and iterating it
yields that turn's events from the steer on (`turnId` and `output` in the
options are ignored). The adapter emits a `user-message` inside the running
turn for the injected input. Without `steer`, a prompt during a turn still
rejects with `SessionBusyError`.

## Remote sessions: `serveSession` / `connectSession`

The library defines the envelope (commands with a `commandId`, one reply each,
`hello` / `event` / `gap` frames) and the semantics (idempotent commands, gapless
replay from any `(epoch, seq)`, reconnects); the app chooses the topology. A
transport is two functions — the same shape `useChat`'s `stream` option has.

```ts
// Server — wherever the session lives.
import { serveSession } from '@sigx/ai-agent/wire';
const served = serveSession(session, { agentId: agent.id, capabilities: agent.capabilities, eventLog });

// Client — anywhere: a browser, a phone, another process.
import { connectSession } from '@sigx/ai-agent/wire';
const remote = await connectSession({ send: (command) => post(command), events: (from) => stream(from) });
const turn = remote.prompt('Summarise the incidents.'); // an AgentSession, indistinguishable from a local one
```

**`serverStream` + `serverFn` recipe** (`@sigx/server`): a `serverFn` whose
handler calls `served.handleCommand(command, rq.principal)` and a
`serverStream` whose handler yields `served.events(from, { signal: rq.abortSignal })`;
their client stubs are `(input) => Promise<R>` and `(input) => AsyncIterable<T>`,
so `connectSession({ send: (c) => agentCommand({ sessionId, command: c }), events: (from) => agentEvents({ sessionId, from }) })`
is the whole client.

**WebSocket recipe**: the socket carries two kinds of JSON messages the app
defines (they are not part of the wire envelope, which only knows commands,
replies and frames): a wire command — the server passes it to `handleCommand`
and sends the reply back, matched by `commandId` — and an app-level
"start streaming from `from`" message, on which the server runs
`for await (const frame of served.events(from)) ws.send(JSON.stringify(frame))`.
The client's `send` posts a command and awaits the reply with its `commandId`;
its `events(from)` sends the start message and yields the frames that follow.

Coalescing (`coalesce: { maxDelayMs, maxBytes }`) merges runs of text deltas
into one frame each to limit traffic; off by default. Without an `eventLog`, a
client whose cursor has left the in-memory buffer receives a `gap` frame and
continues from the head — a `TranscriptStore` snapshot is the app's way to fill it.

**Reconnects.** A broken stream is retried from the last cursor with backoff
(`reconnect: { maxAttempts, backoffMs }`; default 10 attempts, exponential from
250 ms and capped at 10 s). The client reports where it stands as `status`
(`connecting` · `connected` · `reconnecting` · `lost` · `closed`;
`onStatusChange(listener)` observes it, `connected` is `status === 'connected'`).
Once the attempts run out — or at once with `reconnect: false` — the client is
`lost`, not gone: the session still exists, the local buffer stays open and
in-flight turns keep waiting, so `remote.reconnect()` (a button, a
"back online" event) resumes exactly where the stream broke. `closed` is
final: `disconnect()` / `close()` end the buffer and reject pending turns, and
a session that shuts down cleanly (its last event is `state: closed`) ends the
client the same way rather than as `lost`.

**Errors keep their code.** A command the server refuses rejects with
`RemoteCommandError` — an `AgentError` whose `remote` is the wire code
(`unauthorized`, `closed`, `unsupported`, `invalid`, `internal`) and whose
`command` names what was sent, so a client branches on the code rather than a
message. A `busy` prompt is a `SessionBusyError`, as locally. On the server,
`handleCommand` validates each payload's shape (prompt parts, decision, patch)
and answers `invalid` before anything reaches the session.

## Coding agents

The core knows nothing about files or shells. `@sigx/ai-agent/coding` adds the
shared vocabulary coding harnesses need — as typed extension events, never as
new core event types — plus policies that speak it:

```ts
import { createReducer, firstMatch } from '@sigx/ai-agent';
import { allowCategories, denyOutside, codingExtension, codingState } from '@sigx/ai-agent/coding';

// A CI bot: read and search anywhere in the checkout, nothing else, nothing outside it.
const policy = firstMatch(denyOutside(cwd), allowCategories(['read', 'search']));

const reduce = createReducer({ extensions: [codingExtension()] });
// … reduce events …
codingState(transcript)?.diffs; // every diff the agent made, tagged with its turn and tool call
```

## Our engine as an agent: `modelAgent`

`modelAgent({ model, tools?, system?, maxSteps?, store?, pricing? })` runs each
prompt as one `streamText` turn over the session transcript. Every client tool
call goes through the session's policy (`permissions: 'every-call'`); a `'ask'`
becomes a `request` event an interactive client answers with
`session.respond()`, and a headless session denies it. Structured output is
`prompt(input, { output: { schema } })` → `turn.result.output`. The transcript
is the resumable state: with a `TranscriptStore` the `SessionRef` names it,
without one the ref carries it — and session grants live in it, so a resumed
session is not asked again for a tool the user allowed for the session.
`session({ resume, fork: true })` copies the conversation into a new session
id (`fork: true`) with no grants and no open requests. `pricing(usage)` turns
a turn's usage into `costUsd` on the `usage` event, the result and the
transcript; the `LanguageModel` seam carries no price list, so without it no
cost is reported.

**U1 — an edge chat agent** (workerd, Bun, Deno — no Node globals):

```ts
const agent = modelAgent({ model, tools, store: myKvTranscriptStore });
const session = await agent.session(ref ? { resume: ref } : {});
const turn = session.prompt(userInput);
for await (const chunk of toChatStream(turn)) send(chunk); // plain useChat on the client
persist(session.ref);
```

**U2 — a headless job** (CI, cron) returning a typed result:

```ts
const session = await agent.session({ interactive: false, policy: firstMatch(denyOutside(cwd), allowReadOnly) });
const { stopReason, output } = await session.prompt('Review the diff.', { output: { schema: Verdict } }).result;
```

## An agent as a tool: `agentTool`

`agentTool(delegate, { name, description, input, output?, prompt })` returns
a `defineTool` tool that opens a headless session on `delegate`, prompts it
with `prompt(input)` and returns its structured output (or its final text).
Inside a `modelAgent` turn the delegate's events are forwarded with
`parentCallId` set to the calling tool call, so a UI can show the nested work;
`ctx.signal` cancels the delegate.

## Rendering a transcript

Fold events into a transcript with `reduceAgentEvent` (in place, deterministic:
replaying the same events from any snapshot gives the same result), then hand
it to anything that already renders `@sigx/ai` messages:

```ts
import { createTranscript, reduceAgentEvent, toUIMessages } from '@sigx/ai-agent';

const transcript = createTranscript(session.id);
for await (const event of session.subscribe()) {
    reduceAgentEvent(transcript, event);
    render(toUIMessages(transcript)); // UIMessage[] — the shape useChat renders
}
```

`toChatStream(turn)` is the read-only shortcut for a plain `useChat`: it turns
one turn into `UIChunk`s.

A reasoning part is `done` once its `part-end` arrived. That matters because a
harness may open a real reasoning part and redact its TEXT — Claude Code
streams empty deltas and reports progress as tokens instead — so empty text
alone cannot tell "still thinking" from "thought and showed nothing":

```tsx
if (part.type === 'reasoning') {
    if (part.text) return <details open={!part.done}>{part.text}</details>;
    const n = view.usage?.reasoningTokens;
    return part.done ? null : <span>Thinking…{n ? ` ${n} tokens` : ''}</span>;
}
```

### Sub-agents in the transcript

Every sub-agent an `agent-start` announced lives under `transcript.agents`
(by id, with its `status`, cumulative `usage`, `output` and the `callId` that
spawned it), and the spawning tool part carries `agentId` back. The reducer
derives `depth` and `parentAgentId` from the call chain, so a harness's own
depth only counts for an ambient agent that no call started. Selectors build
the views from that flat record:

```ts
import { agentTree, walkAgents, spawnedAgent, callerAgent, agentMessages, agentsUsage } from '@sigx/ai-agent';

agentTree(transcript);                 // AgentNode[] — { agent, children }, start order
walkAgents(transcript, (agent, depth) => …);
spawnedAgent(transcript, callId);      // the agent this call started
callerAgent(transcript, callId);       // the agent that MADE this call (undefined: the session)
agentMessages(transcript, agentId);    // the messages produced inside it
agentsUsage(transcript);               // summed over every agent — separate from transcript.usage
```

A sub-agent's messages stay in `transcript.messages` with their
`parentCallId`. `toUIMessages` flattens them into the calling message as a
marked text part by default; `toUIMessages(t, { subagents: 'omit' })` drops
them — what a host feeding its transcript back to a model wants, so a
delegate's words are never taken for its own. `promptPartsToUI(parts)` is the
user half of that mapping on its own.

## Usage: the well-known keys

`Usage` (from `@sigx/ai`) is an open index signature, but adapters do not get
to invent names for the same number. An adapter that has one of these reports
it under **this** key, so a client reads it without knowing which harness
produced it:

| Key | Means |
|---|---|
| `inputTokens` / `outputTokens` | the two every harness reports |
| `reasoningTokens` | of `outputTokens`, how many were reasoning — a BREAKDOWN, never an addition. ACP's `thoughtTokens`, Codex's `reasoningOutputTokens`, Claude Code's `output_tokens_details.thinking_tokens`. |
| `cacheReadInputTokens` / `cacheCreationInputTokens` | prompt-cache reads and writes. ACP's `cachedReadTokens` / `cachedWriteTokens`, Codex's `cachedInputTokens` / `cacheWriteInputTokens`. |
| `totalTokens` | the harness's own total, when it reports one |

`usage { scope: 'turn' }` **adds** and `usage { scope: 'session' }`
**replaces** — so a harness that reports reasoning progress as it goes streams
it turn-scope (the count grows while the block runs, which is what a
"thinking…" affordance reads), and a figure that is already a total belongs on
the session-scope event or on `turn-end`, never on both.

## Building a UI: `useAgentSession`

`@sigx/ai-agent/app` is the reducer as reactive state. It sits on
`@sigx/runtime-core` and `@sigx/reactivity` — never the `sigx` umbrella — so a
web app, a terminal REPL and a Lynx app use the same composable.

```tsx
import { useAgentSession } from '@sigx/ai-agent/app';

const view = useAgentSession(session); // a local AgentSession, or a connectSession client

// view.transcript · .messages · .state · .turn · .requests · .usage · .costUsd
//     .config · .error · .live · .connected · .capabilities
// view.prompt(input, opts?) · .respond(requestId, decision) · .cancel() · .configure(patch) · .reconnect()

<>
    {view.messages.map((m) => m.parts.map((p) => (p.type === 'text' ? <span>{p.text}</span> : <ToolCard part={p} />)))}
    {view.requests.map((r) => (
        <button onClick={() => view.respond(r.requestId, { type: 'permission', outcome: 'allow', scope: 'session' })}>Allow {r.toolName}</button>
    ))}
    {view.capabilities?.cancel && view.state === 'running' && <button onClick={() => view.cancel()}>Cancel</button>}
</>;
```

What it guarantees:

- **Fine-grained updates.** The transcript is one reactive proxy and the
  reducer folds IN PLACE, so a `part-delta` is `part.text += delta` — one
  property write, observed by the one text node that reads it. The message
  list does not re-run per token.
- **SSR-safe.** The subscription starts on MOUNT: a server render folds
  nothing and opens no queue.
- **Unmount unsubscribes; it does not close the session.** The session
  usually outlives the component — another tab, another device, the server.
  After unmount nothing touches the view again: an action that settles late
  (a turn still running when the user navigated away) writes no state and
  fires no callback, while the turn itself carries on.
- **Late join by default.** It subscribes from `{ epoch: 0, seq: 0 }`, so a
  second tab replays the conversation and then follows it live. Pass
  `{ from: 'live' }` or an explicit cursor to start elsewhere.
- **Extensions plug in**: `useAgentSession(session, { extensions: [codingExtension()] })`
  uses the same `createReducer` plugins the headless reducer takes.
- **Actions never reject.** A busy session or a broken transport lands in
  `view.error` (and `onError`), so a click handler needs no `catch`;
  `prompt()` resolves `undefined` in that case and with the `TurnResult`
  otherwise.
- **A lost connection is visible and recoverable.** `view.connected` follows
  a `connectSession` client's `status` (for a local session it equals `live`).
  When the client goes `lost`, `error` is set with `recoverable: true` and
  `onError` fires — the transcript is intact and the turn still pending — and
  `view.reconnect()` picks the session back up from where the stream broke.
  A session that closes cleanly ends the subscription with no error; a
  subscription that ends while the session is still open is reported as one.

[`examples/agent`](https://github.com/signalxjs/ai/tree/main/examples/agent)
is the whole picture: `serveSession` on the server, `connectSession` +
`useAgentSession` in the browser, tool cards, permission prompts, cancel,
usage, and a second tab that joins the same session.

## Writing an adapter: run `agentConformance`

An adapter is a mapping from a harness onto the contract; the conformance
suite checks the contract's invariants (gapless `seq`, one `turn-end` per turn,
every request resolved exactly once, replay equality, cancel → `cancelled`, …)
through twenty-one scenarios: `text`, `tool-permission`, `headless-deny`,
`tool-error`, `slow-tool`, `model-error`, `resume`, `input-request`,
`structured-output`, `support-agent`, `busy-session`, `session-grant`,
`request-timeout`, `configure`, `fork`, `list-sessions`, `late-join`,
`portable-resume`, `prompt-after-close`, `respond-unknown` and `usage`. Each
scenario tells your factory what the agent must do — for a real harness that is
a recorded fixture or a fake peer; the suite plays the client. A case that needs
a capability the agent lacks is skipped with the reason (pass `capabilities` so
the skips are computed up front and can be asserted; without them a scenario the
agent cannot run passes as a no-op). `late-join` replays the session from
`{ epoch: 0, seq: 0 }` and holds it to `checkEventInvariants(events, { fromStart:
true })` — gapless from seq 1 in every epoch. No test-runner import: wire the
cases into yours.

Capabilities are enforced where the helpers can: `createSessionCore({ promptParts })`
fails a prompt that carries a part beyond the declared level before any event
is emitted (`mockAgent` and `modelAgent` pass theirs), and `mockAgent` treats
`cancel()` as a no-op without the `cancel` capability.

`createSessionCore` also owns steering and sub-agent control, so an adapter
only maps: pass `steer` and `subagents` from your capabilities; in the turn's
`run`, call `ctx.onSteer(parts => …)` to receive steering input (input that
arrived earlier is delivered on registration) — inject it natively and
`driver.emit` the `user-message`; call `ctx.resolve(request, { parentCallId })`
for a request a sub-agent raised; and `core.attach({ respond, cancel })` a
delegate session you opened so `respond()` and `cancel({ agentId })` reach it
(detach with the returned function). Both forward only with `subagents:
'control'`: on any other core an unknown `respond()` id stays a no-op and
`cancel({ agentId })` rejects with `protocol_error`.

```ts
import { agentConformance } from '@sigx/ai-agent/testing';

for (const c of agentConformance((scenario) => makeMyAgent(scenario), { capabilities: myAgent.capabilities })) {
    it.skipIf(!!c.skip)(c.name, c.run);
}
```

## Record and replay

`recordAgent(agent)` wraps any agent and records, per session, the client's
commands interleaved with the events the session emitted; `replayAgent(fixture)`
plays it back through the real session helpers and throws with a diff the moment
the client deviates. A live run against a harness becomes a fixture test:

```ts
import { recordAgent, replayAgent, serializeFixture } from '@sigx/ai-agent/testing';

const recorder = recordAgent(claudeCode());          // any Agent
// … drive a session through `recorder` …
await writeFile('fixtures/edit.json', serializeFixture(recorder.fixture));

// later, in a test:
const agent = replayAgent(JSON.parse(await readFile('fixtures/edit.json', 'utf8')));
```

## Protocol kit

Protocol-based adapters (ACP, Codex app-server) are mappings, not transport
code: `createJsonRpcPeer` speaks JSON-RPC 2.0 over any pair of Web Streams —
a child process's stdio, a WebSocket (`webSocketStreams`), an in-memory
`TransformStream` in tests — with requests in both directions, cooperative
cancellation and backpressure. `createMcpToolHandler(tools, { name, version,
auth })` exposes `defineTool` tools to a harness over MCP's Streamable HTTP
transport (JSON-only, tools only, bearer-authenticated); serve it with any
`(Request) => Promise<Response>` host — on Node, `@sigx/ai-agent-node`'s
`listenMcp`.

```ts
import { createJsonRpcPeer, createMcpToolHandler } from '@sigx/ai-agent/harness';

const peer = createJsonRpcPeer({ readable, writable });        // e.g. a spawned agent's stdout / stdin
peer.onRequest('session/request_permission', async (params, ctx) => decide(params, ctx.signal));
const init = await peer.request('initialize', { protocolVersion: 1 });

const handler = createMcpToolHandler([weather], { name: 'my-app', version: '1.0.0', auth: (r) => r.headers.get('authorization') === `Bearer ${token}` });
```

## Install

```bash
npm install @sigx/ai @sigx/ai-agent
```

Peers on `@sigx/ai` at the same minor. `@sigx/ai-agent/app` also peers on
`@sigx/reactivity` and `@sigx/runtime-core` — any sigx app already has them;
the other entries do not touch them.

## Documentation

Guides and the contract reference: **<https://sigx.dev/ai/>** — the design
lives in [signalxjs/ai#35](https://github.com/signalxjs/ai/issues/35).

## License

MIT © Andreas Ekdahl
