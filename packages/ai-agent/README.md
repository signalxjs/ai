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

Three entries today (more land with the following milestones):

| Entry | What |
|---|---|
| `@sigx/ai-agent` | the contract (`Agent`, `AgentSession`, `AgentTurn`), the event union, capabilities, the policy engine (`resolveRequest`, `allowAll`, `allowReadOnly`, `firstMatch`, …), the session helpers adapters build on (`createEventLog`, `createTurn`, `createSessionCore`), the transcript reducer (`reduceAgentEvent`, `createReducer`) with its bridges to `@sigx/ai` (`toUIMessages`, `fromUIMessages`, `toChatStream`), the store seams (`TranscriptStore`, `EventLogStore`), `modelAgent` (our engine as an agent) and `agentTool` (an agent as a tool) |
| `@sigx/ai-agent/harness` | the protocol kit: `createJsonRpcPeer` (JSON-RPC 2.0 over Web Streams, both directions), NDJSON framing, `createMcpToolHandler` (client tools as an MCP server, Streamable HTTP), `webSocketStreams` |
| `@sigx/ai-agent/testing` | `mockAgent` — a scripted, deterministic agent — and `agentConformance`, the suite every adapter must pass |

## Our engine as an agent: `modelAgent`

`modelAgent({ model, tools?, system?, maxSteps?, store? })` runs each prompt
as one `streamText` turn over the session transcript. Every client tool call
goes through the session's policy (`permissions: 'every-call'`); a `'ask'`
becomes a `request` event an interactive client answers with
`session.respond()`, and a headless session denies it. Structured output is
`prompt(input, { output: { schema } })` → `turn.result.output`. The transcript
is the resumable state: with a `TranscriptStore` the `SessionRef` names it,
without one the ref carries it.

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
