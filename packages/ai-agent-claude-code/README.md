# @sigx/ai-agent-claude-code

> **Experimental** — 0.x, part of the `@sigx/ai-agent` family (see
> [signalxjs/ai#35](https://github.com/signalxjs/ai/issues/35)).

Claude Code as an [`@sigx/ai-agent`](https://www.npmjs.com/package/@sigx/ai-agent)
`Agent`, on the official
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript). One
`query()` per session; every `prompt()` is one turn; the permissions Claude
Code asks about go through the session's policy; your `defineTool` tools are
served to the CLI over MCP; the process is spawned through
`@sigx/ai-agent-node`, so cancelling and disposing terminate the whole tree on
Windows, macOS and Linux.

```ts
import { firstMatch, allowReadOnly } from '@sigx/ai-agent';
import { allowCategories, denyOutside } from '@sigx/ai-agent/coding';
import { claudeCode } from '@sigx/ai-agent-claude-code';

// U2 — a headless CI bot: read and search inside the checkout, nothing else.
const agent = claudeCode();
const session = await agent.session({
    cwd,
    interactive: false,
    policy: firstMatch(denyOutside(cwd), allowCategories(['read', 'search']), allowReadOnly)
});
const { stopReason, output } = await session.prompt('Review the diff in this checkout.', { output: { schema: Verdict } }).result;
await agent.dispose();
```

## What it maps

| Claude Code | `AgentEvent` |
|---|---|
| streamed text / thinking blocks | `part-start` / `part-delta` / `part-end` (thinking keeps its signature as `providerData`). Thinking arrives as a SUMMARY by default (`thinking: { type: 'adaptive', display: 'summarized' }`); under `display: 'omitted'` the block is still real but every `thinking_delta` carries `''`, and an EMPTY delta emits no `part-delta`. |
| `system/thinking_tokens` | `usage { scope: 'turn', usage: { reasoningTokens } }` — the increment, so the well-known key grows live while a thinking block runs — summarized or not and any client can show "thinking…" without knowing this namespace. Also `ext { ns: 'claude-code', name: 'thinking_tokens' }` with the raw frame. It is the CLI's own estimate; the billed count arrives with `result`. |
| `tool_use` / `tool_result` / `tool_progress` | `tool-call` + `tool-update pending → in_progress → completed / failed / denied`; Edit, MultiEdit and Write add `coding.diff`, TodoWrite adds `coding.plan` |
| `parent_tool_use_id` (subagents) | `parentCallId` on every nested event, `actor` = the sub-agent type Claude Code named (`Explore`, …; `'subagent'` when it did not). The nested TEXT and thinking are forwarded by default (`forwardSubagentText`); `subagentTranscript: false` keeps only the sub-agent's tool calls. |
| `system/task_started` / `task_progress` / `task_updated` / `task_notification` | `agent-start { agentId: task_id, callId: tool_use_id, kind: 'subagent' \| 'workflow', title, description: prompt, depth: spawn_depth, background }` and `agent-update { status, summary, usage }` — one start and one terminal update per agent, whichever frame ends it first (the Task call's own `tool_use_result` on a foreground agent, a `task_notification` on a background one; `stopped` / `killed` read `cancelled`). A Workflow-tool run is a sub-agent of kind `workflow` titled by its `meta.name`. Backgrounded Bash, MCP and ambient tasks are not agents and stay `ext`. A foreground agent still running at `result` ends `failed` (or `cancelled` after an interrupt); a background one ends when the session closes. `summary` needs `agentProgressSummaries: true` (model calls) — otherwise it is the last tool name. |
| `Query.stopTask` | `cancel({ agentId })` — a `stopped` notification follows and reads `cancelled`; a target that is already over is a no-op |
| `Options.agents` | `session({ agents: { reviewer: { description, prompt, tools, model, maxTurns } } })` — programmatic sub-agent definitions the model can spawn (`defineAgents: true`) |
| `canUseTool` | `request` / `request-resolved` through `resolveRequest` — allow with the input unchanged, or deny with a message the model sees |
| `AskUserQuestion` | `request { kind: 'input' }` carrying a `schema` (one property per question — an array for a multi-select, the labels as an `enum` branch beside an open string, since the tool always allows a free-text "Other"), the options flattened as `q<n>:<label>`, and the questions as `message`. `respond(id, { type: 'input', answers: { q1, q2, … } })` answers them: the answers ride back on `updatedInput`, keyed by question text, so the model sees "The user answered: …" — a question the operator did answer is never reported as a denial. Nobody to ask (a headless session, or a policy that declines) denies with "The questions were not answered." |
| `result` | `usage` (turn, and the session's cumulative cost) + `turn-end` (`end_turn`, `max_tokens`, `max_turns`, `cancelled`, `error` incl. `context_exceeded`). The billed `reasoningTokens` (`output_tokens_details.thinking_tokens`, summed from `modelUsage` for the session) rides the session-scope event and `turn-end`, which ASSIGN and so replace the streamed estimate — never the turn-scope event, which would add it twice. |
| `system/init` | `config` (model, permission mode, and `thinkingDisplay` when the session knows it); `configure({ model, permissionMode, thinkingDisplay })` calls `setModel` / `setPermissionMode` / `setMaxThinkingTokens` |
| auth and rate-limit frames | `error { code: 'auth_required' \| 'rate_limited' }`; everything else `ext { ns: 'claude-code' }` |

Capabilities: `resume: 'local'`, `fork`, `cancel`, `config`, `structuredOutput`,
`promptParts: 'text+image'`, `tools: 'mcp'`, `permissions: 'harness-filtered'`
(Claude Code's `default` mode runs read-only builtins without asking, so not
every call reaches the policy), `listSessions`, `subagents: 'control'` (the
task frames above, `cancel({ agentId })`, and a sub-agent's permission
questions answered through the same `respond()`), `defineAgents`.

`steer` is **off**. A second user message does reach the CLI mid-turn, but
the CLI decides whether it folds into the running turn between tool rounds or
becomes a turn of its own after the result — so a `prompt()` while a turn runs
is refused with `SessionBusyError` rather than promised. The live test suite
carries a probe that records which of the two happens (`SIGX_LIVE_CLAUDE_CODE=1`).

## Options

`claudeCode({ pathToClaudeCodeExecutable?, settingSources?, permissionMode?, env?, toolServerName?, query?, spawn?, listen? })`.
Sessions take `CodingSessionOptions` (`cwd` is required) plus `model`,
`system` (a custom system prompt; `systemPromptPreset: true` appends it to
Claude Code's own), `maxTurns`, `maxBudgetUsd`, `additionalDirectories`,
`resume` / `fork` from a `SessionRef`, `agents` (sub-agent definitions),
`thinking`, `subagentTranscript` (default `true`) and
`agentProgressSummaries` (default `false`).

- **Settings are isolated by default** (`settingSources: []`): the user's and
  the project's Claude Code settings do not apply. Opt in with
  `settingSources: ['user', 'project', 'local']`.
- **Permission mode** defaults to `'default'`. `'bypassPermissions'` is
  refused unless `allowDangerouslySkipPermissions: true` is set as well.
- **Thinking** defaults to `{ type: 'adaptive', display: 'summarized' }` — the
  SDK's own default display is `omitted`, which leaves every reasoning part
  empty. The summary is free: it describes thinking that is billed either way
  (measured against the real CLI, `output_tokens` tracks
  `output_tokens_details.thinking_tokens` identically in both modes), and
  `adaptive` degrades to the model's own thinking mode on models that predate
  it rather than erroring. Pass any `ThinkingConfig` to override
  (`{ type: 'enabled', budgetTokens }`, `{ type: 'disabled' }`, or
  `display: 'omitted'`), or `null` to send none at all and inherit Claude
  Code's own `thinking.display` / `--thinking-display` setting. Mid-session,
  `configure({ thinkingDisplay: 'summarized' | 'omitted' })` switches the
  display through `setMaxThinkingTokens`, keeping the session's thinking mode.
  A session that advertises no `thinkingDisplay` — thinking disabled, or
  `thinking: null` deferring to the CLI's own setting — refuses the patch
  rather than overriding what it was told to leave alone.
- **Structured output** is per query in the SDK: a `prompt(input, { output })`
  whose schema differs from the running query's restarts the query with
  `resume`, transparently.
- **Environment**: the CLI gets an allowlist (`PATH`, home, temp, proxies, …)
  plus `ANTHROPIC_*` and `CLAUDE_CONFIG_DIR`, and whatever you pass as `env`.

## Authentication and terms

The adapter never collects, stores or forwards credentials. Claude Code uses
whatever it is signed in with, or `ANTHROPIC_API_KEY` from the environment.
Read Anthropic's [authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance)
terms: products that serve other users must follow them — for developer
products that means API-key authentication.

## Install

```bash
npm install @sigx/ai @sigx/ai-agent @sigx/ai-agent-claude-code @anthropic-ai/claude-agent-sdk
```

The Agent SDK is a peer; it bundles the Claude Code executable for your
platform, so no separate install is needed.

## Documentation

**<https://sigx.dev/ai/>**

## License

MIT © Andreas Ekdahl
