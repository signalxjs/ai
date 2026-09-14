# @sigx/ai-agent-codex

> **Experimental** — 0.x, part of the [`@sigx/ai-agent`](https://www.npmjs.com/package/@sigx/ai-agent) family.

Codex as an `Agent`, over the `codex app-server` JSON-RPC protocol: threads
are sessions, turns are prompts, Codex's approvals and questions go through
your policy, and your `defineTool` tools are registered as Codex dynamic tools
(no MCP hop). Sign-in is Codex's own (`codex login` or `OPENAI_API_KEY`); the
adapter never collects or stores credentials.

```ts
import { firstMatch, allowReadOnly } from '@sigx/ai-agent';
import { allowCategories, denyOutside } from '@sigx/ai-agent/coding';
import { codex } from '@sigx/ai-agent-codex';

// U2 — a headless review bot: read and search inside the checkout, nothing else.
const agent = codex();
const session = await agent.session({
    cwd,
    interactive: false,
    policy: firstMatch(denyOutside(cwd), allowCategories(['read', 'search']), allowReadOnly)
});
const { stopReason, output } = await session.prompt('Review the diff and rate it.', { output: { schema: Verdict } }).result;
await agent.dispose(); // kills the app-server tree, on Windows too
```

## What maps onto what

| Codex | Contract |
|---|---|
| `thread/start` / `thread/resume` / `thread/fork` / `thread/list` | `session()` / `resume: 'local'` / `fork` / `listSessions()` |
| `turn/start` … `turn/completed` (`completed`, `interrupted`, `failed`) | one turn (`end_turn`, `cancelled`, `error` with `codexErrorInfo` → `context_exceeded`, `rate_limited`, `auth_required`, `provider_error`) |
| `turn/interrupt` | `cancel()`; on a sub-agent's thread, `cancel({ agentId })` |
| `turn/steer` | `prompt()` while a turn runs (`steer: true`): the input joins the running turn as a second `user-message`; a refusal is a recoverable `error` in that turn |
| `agentMessage`, `plan`, `reasoning` items and their deltas | text and reasoning parts |
| `commandExecution` + `outputDelta` | `tool-call { name: 'shell', category: 'execute' }`, `coding.terminal`, `coding.terminal-exit` |
| `fileChange` + `patchUpdated` | `tool-call { name: 'apply_patch', category: 'edit' }`, `coding.diff`, `coding.files-changed` |
| `mcpToolCall`, `dynamicToolCall`, `webSearch` | `tool-call` / `tool-update` |
| `collabAgentToolCall` (`spawnAgent`, `wait`, `sendInput`, `interruptAgent`, …) | `tool-call { name: 'collab/<tool>', category: 'other' }` / `tool-update`; the spawned thread is an `agent-start { kind: 'subagent', callId }` bound to the spawn call, and every change in the reported `agentsStates` an `agent-update` (`completed` with the agent's message as `output`, `errored` / `notFound` → `failed`, `interrupted` / `shutdown` → `cancelled`) |
| `subAgentActivity` | a `started` activity for a thread not yet seen is the spawn (Codex 0.154 reports it this way): `tool-call { name: 'collab/spawnAgent' }` under the activity's id, with the thread's `agent-start` bound to it; every activity is an `agent-update` for its thread (`started` / `interacted` → `running` with the kind as `summary`, `interrupted` → `cancelled`, `completed`); a thread first seen through another kind is announced without a spawning call |
| a sub-agent thread's own `turn/*`, `item/*` and deltas | the same parts and tool calls, nested under the spawn call (`parentCallId`), spoken by the agent (`actor`: its nickname, role, or the last segment of its path); its requests go through your policy with the same `parentCallId`; its `thread/tokenUsage/updated` is `agent-update.usage`, never the host's `usage` |
| `turn/plan/updated` | `coding.plan` |
| `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` | `request { kind: 'permission' }` through your policy → `accept` / `acceptForSession` / `decline` / `cancel` |
| `item/tool/requestUserInput` | `request { kind: 'input' }` |
| `item/tool/call` | your tool, through the policy, then `AnyTool.run` |
| `thread/tokenUsage/updated` | `usage { scope: 'turn' }` and `usage { scope: 'session' }` |
| `model/list`, approval policy, sandbox | `config` events (a mode we do not model, such as a granular approval policy, is listed as its own value); `configure()` applies on the next turn — `sandbox` becomes that turn's `sandboxPolicy` |
| everything else | `ext { ns: 'codex' }` |

The contract's turn id is ours (a caller-supplied `turnId` is honoured);
Codex's own turn id is announced as `ext { ns: 'codex', name: 'turn' }`.
A `prompt()` during a turn does not start a second one: it is sent as
`turn/steer` with that Codex turn as `expectedTurnId` (waiting for
`turn/start` to answer first), and the handle you get back is the running
turn's — same `id`, same `result`. Codex may refuse a steer (the turn just
ended, or it is a review or compaction turn); that comes back as
`error { code: 'protocol_error', recoverable: true }` inside the turn and the
turn carries on without the input.

### Sub-agents

Codex runs a sub-agent as a thread of its own, reports it on the parent
thread, and streams the child thread's turns on the same connection, so the
adapter declares `subagents: 'control'`. You see every sub-agent as an
`agent-start` bound to the `collab/spawnAgent` call that started it and follow
it through `agent-update`s, exactly one terminal per agent. Its own transcript
nests under that call: text, reasoning and tool calls carry the call as
`parentCallId` and the agent as `actor`, and a request it raises (a command
approval, a question) reaches your policy — and `respond()` — with the same
`parentCallId`. Its token usage is `agent-update.usage`; the host's `usage`
events stay the host's. Frames Codex sends for the child before the activity
that names it are held and replayed once it is known.

`cancel({ agentId })` sends `turn/interrupt` for the child's running turn — or,
when it has none yet (just spawned, or waiting for the parent), for the next
one it starts — and the agent ends `cancelled` when that turn does. The
parent's turn goes on. A finished or unknown agent is refused with
`protocol_error`. A sub-agent can outlive the turn that spawned it: one still
running when its turn completes stays `running`; an interrupted host turn
cancels them, and so does closing the session.

What was verified against Codex CLI 0.154 is in
[signalxjs/ai#100](https://github.com/signalxjs/ai/issues/100): the spawn
arrives as a `subAgentActivity` "started" item rather than a `spawnAgent`
collab call, and the child thread is never announced with `thread/started`.
Both shapes are handled. Child approval requests did not occur in that capture,
so their routing is covered by tests against the fake app-server only.

## Sandbox and approvals

With a `policy`, sessions default to `approvalPolicy: 'untrusted'` and
`sandbox: 'workspace-write'` — the strictest settings under which Codex still
asks for everything it can ask for. Codex auto-runs commands it deems trusted
without asking, so the adapter declares `permissions: 'harness-filtered'`.
Session-scoped grants (`scope: 'session'` → `acceptForSession`) live in the
session's memory; nothing is written to Codex's trust settings.

## Transport

`codex()` resolves `codex` on `PATH` (an npm `.cmd` shim runs under
`process.execPath`), spawns `codex app-server` with an allowlisted environment
plus `OPENAI_API_KEY` and `CODEX_HOME` (`passEnv` to add more), and speaks
NDJSON JSON-RPC over stdio. `transport: { readable, writable }` drives an
already-running server instead — a WebSocket (`codex app-server --listen
ws://…` through `webSocketStreams`), or an in-memory fake in tests.

## Types

`src/schema.ts` is a hand-written subset of the v2 protocol, checked against
the generated types of Codex CLI 0.153.4 (`@pwrdrvr/codex-app-server-protocol`,
a devDependency). `pnpm --filter @sigx/ai-agent-codex codex:generate` regenerates
the full types into `generated/` with the Codex CLI you have installed
(`codex app-server generate-ts --experimental`), for diffing.

## Install

```bash
npm install @sigx/ai @sigx/ai-agent @sigx/ai-agent-codex
```

Node only (it spawns a process). Codex itself is installed and signed in
separately.

## Documentation

**<https://sigx.dev/ai/>** — design in [signalxjs/ai#35](https://github.com/signalxjs/ai/issues/35).

## License

MIT © Andreas Ekdahl
