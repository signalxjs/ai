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
| `turn/interrupt` | `cancel()` |
| `agentMessage`, `reasoning` items and their deltas | text and reasoning parts |
| `commandExecution` + `outputDelta` | `tool-call { name: 'shell', category: 'execute' }`, `coding.terminal`, `coding.terminal-exit` |
| `fileChange` + `patchUpdated` | `tool-call { name: 'apply_patch', category: 'edit' }`, `coding.diff`, `coding.files-changed` |
| `mcpToolCall`, `dynamicToolCall`, `webSearch` | `tool-call` / `tool-update` |
| `turn/plan/updated` | `coding.plan` |
| `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` | `request { kind: 'permission' }` through your policy → `accept` / `acceptForSession` / `decline` / `cancel` |
| `item/tool/requestUserInput` | `request { kind: 'input' }` |
| `item/tool/call` | your tool, through the policy, then `AnyTool.run` |
| `thread/tokenUsage/updated` | `usage { scope: 'turn' }` and `usage { scope: 'session' }` |
| `model/list`, approval policy, sandbox | `config` events; `configure()` applies on the next turn |
| everything else | `ext { ns: 'codex' }` |

The contract's turn id is ours (a caller-supplied `turnId` is honoured);
Codex's own turn id is announced as `ext { ns: 'codex', name: 'turn' }`.
`turn/steer` is not wired yet (`steer: false`).

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
