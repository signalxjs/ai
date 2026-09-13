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
for await (const event of turn) {
    if (event.type === 'part-delta') process.stdout.write(event.delta);
}
const { stopReason } = await turn.result; // 'end_turn'
```

Two entries today (more land with the following milestones):

| Entry | What |
|---|---|
| `@sigx/ai-agent` | the contract (`Agent`, `AgentSession`, `AgentTurn`), the event union, capabilities, the policy engine (`resolveRequest`, `allowAll`, `allowReadOnly`, `firstMatch`, …), and the session helpers adapters build on (`createEventLog`, `createTurn`, `createSessionCore`) |
| `@sigx/ai-agent/testing` | `mockAgent` — a scripted, deterministic agent |

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
