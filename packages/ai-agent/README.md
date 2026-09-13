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
import { allowReadOnly } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

const agent = mockAgent({ script: [[{ text: 'Hello from the agent.' }]] });
const session = await agent.session({ interactive: false, policy: allowReadOnly });
const turn = session.prompt('Say hello');
let text = '';
for await (const event of turn) {
    if (event.type === 'part-delta') text += event.delta;
}
const { stopReason } = await turn.result; // 'end_turn'
console.log(text); // 'Hello from the agent.'
```

Three entries today (more land with the following milestones):

| Entry | What |
|---|---|
| `@sigx/ai-agent` | the contract (`Agent`, `AgentSession`, `AgentTurn`), the event union, capabilities, the policy engine (`resolveRequest`, `allowAll`, `allowReadOnly`, `firstMatch`, …), the session helpers adapters build on (`createEventLog`, `createTurn`, `createSessionCore`), the transcript reducer (`reduceAgentEvent`, `createReducer`) with its bridges to `@sigx/ai` (`toUIMessages`, `fromUIMessages`, `toChatStream`), and the store seams (`TranscriptStore`, `EventLogStore`) |
| `@sigx/ai-agent/wire` | `serveSession` / `connectSession` — a session served in one place and used from another over any transport, with a versioned envelope and replay for late joiners and reconnects |
| `@sigx/ai-agent/testing` | `mockAgent` — a scripted, deterministic agent — and `agentConformance`, the suite every adapter must pass |

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

**WebSocket recipe**: on the socket server, JSON messages with a `commandId`
go to `handleCommand` and the reply is sent back; a `subscribe { from }`
message starts `for await (const frame of served.events(from)) ws.send(JSON.stringify(frame))`.
On the client, `send` posts a command and awaits the matching reply,
`events(from)` yields the frames received after a `subscribe`.

Coalescing (`coalesce: { maxDelayMs, maxBytes }`) merges runs of text deltas
into one frame each to limit traffic; off by default. Without an `eventLog`, a
client whose cursor has left the in-memory buffer receives a `gap` frame and
continues from the head — a `TranscriptStore` snapshot is the app's way to fill it.

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

## Writing an adapter: run `agentConformance`

An adapter is a mapping from a harness onto the contract; the conformance
suite checks the contract's invariants (gapless `seq`, one `turn-end` per turn,
every request resolved exactly once, replay equality, cancel → `cancelled`, …)
through eleven scenarios. Each scenario tells your factory what the agent must
do — for a real harness that is a recorded fixture or a fake peer; the suite
plays the client. A case that needs a capability the agent lacks is skipped
with the reason. No test-runner import: wire the cases into yours.

```ts
import { agentConformance } from '@sigx/ai-agent/testing';

for (const c of agentConformance((scenario) => makeMyAgent(scenario), { capabilities: myAgent.capabilities })) {
    it.skipIf(!!c.skip)(c.name, c.run);
}
```

## Install

```bash
npm install @sigx/ai @sigx/ai-agent
```

Peers on `@sigx/ai` at the same minor.

## Documentation

Guides and the contract reference: **<https://sigx.dev/ai/>** — the design
lives in [signalxjs/ai#35](https://github.com/signalxjs/ai/issues/35).

## License

MIT © Andreas Ekdahl
