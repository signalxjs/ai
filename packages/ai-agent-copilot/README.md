# @sigx/ai-agent-copilot

> **Experimental** — 0.x, part of the [`@sigx/ai-agent`](https://www.npmjs.com/package/@sigx/ai-agent) family.

GitHub Copilot CLI as an `Agent`, on the official
[`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk):
Copilot sessions are sessions, each `send` is a turn, the runtime's
permission asks go through your policy, and your `defineTool` tools run
in-process as Copilot tools (no MCP hop). Sign-in is Copilot's own
(`copilot login`, `gh auth`, or a GitHub token in the environment); the
adapter never collects or stores credentials.

```ts
import { firstMatch, allowReadOnly } from '@sigx/ai-agent';
import { allowCategories, denyOutside } from '@sigx/ai-agent/coding';
import { copilot } from '@sigx/ai-agent-copilot';

// A headless review bot: read and search inside the checkout, nothing else.
const agent = copilot();
const session = await agent.session({
    cwd,
    interactive: false,
    policy: firstMatch(denyOutside(cwd), allowCategories(['read', 'search']), allowReadOnly)
});
const { stopReason } = await session.prompt('Review the diff and summarise it.').result;
await agent.dispose(); // stops the runtime the SDK spawned
```

## What maps onto what

| Copilot | Contract |
|---|---|
| `createSession` / `resumeSession` / `listSessions` | `session()` / `resume: 'local'` / `listSessions()` — the session id is ours (`cp_…`), so events the runtime emits while creating the session are not lost |
| `send()` … `session.idle` | one turn (`end_turn`; `cancelled` after `cancel()` → `abort()`) |
| `assistant.message_delta` / `assistant.message`, `assistant.reasoning_delta` / `assistant.reasoning` | text and reasoning parts (a message that was never streamed is delivered whole at its complete event) |
| `tool.execution_start` / `_progress` / `_partial_result` / `_complete` | `tool-call` (MCP tools as `server/tool`, categories from the name) / `tool-update`; a shell tool's partial output is `coding.terminal` and its completion `coding.terminal-exit` |
| `onPermissionRequest` — `shell`, `write`, `read`, `url`, `mcp`, `custom-tool`, `memory`, `hook` | `request { kind: 'permission' }` through your policy → `approve-once` / `approve-for-session` (only when the runtime offers it) / `reject` with the policy's message as feedback; a `write` ask carries its diff as `coding.diff` |
| `onUserInputRequest` (`ask_user`) | `request { kind: 'input' }`; the answer goes back as text (`wasFreeform` when it is not one of the choices) |
| your tools (`SessionOptions.tools`) | declared on the session from `AnyTool.spec` (the JSON Schema as-is), run through `AnyTool.run`; permission comes from the runtime's `custom-tool` ask — the handler asks itself only when nobody asked for that call |
| `assistant.usage` | `usage { scope: 'turn' }` and `usage { scope: 'session' }` under the shared `Usage` keys (`cacheReadTokens` → `cacheReadInputTokens`, `cacheWriteTokens` → `cacheCreationInputTokens`). Its `cost` is the model's premium-request multiplier, not money, so there is no `costUsd` |
| `subagent.started` / `completed` / `failed` | `agent-start { kind: 'subagent', callId }` bound to the spawning call (announced as `task` when the runtime did not), `agent-update`s (one terminal each), the call settled with the agent; the sub-agent's own events (`agentId` on the envelope) nest under that call with the agent as `actor`, and its usage is `agent-update.usage`, never the host's |
| `session.start` / `session.resume` / `session.model_change`, `listModels()` | `config` events: a switchable `model` (the runtime's enabled models, or `copilot({ models })`; the session's own model is always offered) and `reasoningEffort` (what the model supports); `configure({ model, reasoningEffort })` → `setModel()` and re-announces the whole list |
| `session.error` | `error` (`statusCode` / message → `auth_required`, `rate_limited`, `context_exceeded`, `provider_error`); the turn ends `error` at the `session.idle` that follows, or after `errorSettleMs` (2000) when none does |
| `session({ agents })` | `customAgents` (`defineAgents: true`) |
| everything else | `ext { ns: 'copilot' }` — except the runtime's own chatter (`model.*` telemetry, `assistant.streaming_delta`, `assistant.tool_call_delta`, queue and background-task bookkeeping, `external_tool.*`, `sandbox.*`, the full `system.message`), which is dropped |

Capabilities: `resume: 'local'`, `cancel`, `config`, `tools: 'native'`,
`permissions: 'harness-filtered'` (the runtime runs workspace reads without
asking), `listSessions`, `subagents: 'observe'` (the SDK has no per-agent
cancel), `defineAgents`, `promptParts: 'text'` (`send()` takes text and file
paths, not inline images). No `fork`, no `steer` (a prompt during a turn is
refused as busy — the runtime would queue it as a turn of its own), no
`structuredOutput`.

## Sign-in and the runtime

The SDK bundles the Copilot CLI runtime for your platform and spawns it on the
first `session()`; `cliPath` (or `COPILOT_CLI_PATH`) points at another one. A
runtime that is not signed in fails `session()` with
`AgentError('auth_required')` (`data.hint: 'copilot login'`) — unless the
session brings its own provider (`provider`, bring-your-own-key), which runs
without a GitHub login. `gitHubToken` goes to the runtime as an environment
variable; `env`, `cwd`, `baseDirectory` (`COPILOT_HOME`) and `logLevel` are
the runtime's. `copilot({ client })` takes a ready `CopilotClient` — or, in
tests, anything that satisfies `CopilotClientLike` (the SDK's own classes are
checked against it).

## Install

```bash
npm install @sigx/ai @sigx/ai-agent @sigx/ai-agent-copilot @github/copilot-sdk
```

Node only (the SDK spawns a process). The SDK is a peer dependency; it brings
the runtime with it.

## Documentation

**<https://sigx.dev/ai/>** — design in [signalxjs/ai#35](https://github.com/signalxjs/ai/issues/35).

## License

MIT © Andreas Ekdahl
