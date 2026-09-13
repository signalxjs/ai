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
| `@sigx/ai-agent/harness` | the protocol kit: `createJsonRpcPeer` (JSON-RPC 2.0 over Web Streams, both directions), NDJSON framing, `createMcpToolHandler` (client tools as an MCP server, Streamable HTTP), `webSocketStreams` |
| `@sigx/ai-agent/testing` | `mockAgent` — a scripted, deterministic agent — and `agentConformance`, the suite every adapter must pass |

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

Peers on `@sigx/ai` at the same minor.

## Documentation

Guides and the contract reference: **<https://sigx.dev/ai/>** — the design
lives in [signalxjs/ai#35](https://github.com/signalxjs/ai/issues/35).

## License

MIT © Andreas Ekdahl
