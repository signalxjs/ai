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
| streamed text / thinking blocks | `part-start` / `part-delta` / `part-end` (thinking keeps its signature as `providerData`) |
| `tool_use` / `tool_result` / `tool_progress` | `tool-call` + `tool-update pending → in_progress → completed / failed / denied`; Edit, MultiEdit and Write add `coding.diff`, TodoWrite adds `coding.plan` |
| `parent_tool_use_id` (subagents) | `parentCallId` and `actor: 'subagent'` |
| `canUseTool` | `request` / `request-resolved` through `resolveRequest` — allow with the input unchanged, or deny with a message the model sees |
| `AskUserQuestion` | `request { kind: 'input' }` carrying a `schema` (one property per question — an array for a multi-select, the labels as an `enum` branch beside an open string, since the tool always allows a free-text "Other"), the options flattened as `q<n>:<label>`, and the questions as `message`. `respond(id, { type: 'input', answers: { q1, q2, … } })` answers them: the answers ride back on `updatedInput`, keyed by question text, so the model sees "The user answered: …" — a question the operator did answer is never reported as a denial. Nobody to ask (a headless session, or a policy that declines) denies with "The questions were not answered." |
| `result` | `usage` (turn, and the session's cumulative cost) + `turn-end` (`end_turn`, `max_tokens`, `max_turns`, `cancelled`, `error` incl. `context_exceeded`) |
| `system/init` | `config` (model, permission mode); `configure({ model, permissionMode })` calls `setModel` / `setPermissionMode` |
| auth and rate-limit frames | `error { code: 'auth_required' \| 'rate_limited' }`; everything else `ext { ns: 'claude-code' }` |

Capabilities: `resume: 'local'`, `fork`, `cancel`, `config`, `structuredOutput`,
`promptParts: 'text+image'`, `tools: 'mcp'`, `permissions: 'harness-filtered'`
(Claude Code's `default` mode runs read-only builtins without asking, so not
every call reaches the policy), `listSessions`.

## Options

`claudeCode({ pathToClaudeCodeExecutable?, settingSources?, permissionMode?, env?, toolServerName?, query?, spawn?, listen? })`.
Sessions take `CodingSessionOptions` (`cwd` is required) plus `model`,
`system` (a custom system prompt; `systemPromptPreset: true` appends it to
Claude Code's own), `maxTurns`, `maxBudgetUsd`, `additionalDirectories`,
`resume` / `fork` from a `SessionRef`.

- **Settings are isolated by default** (`settingSources: []`): the user's and
  the project's Claude Code settings do not apply. Opt in with
  `settingSources: ['user', 'project', 'local']`.
- **Permission mode** defaults to `'default'`. `'bypassPermissions'` is
  refused unless `allowDangerouslySkipPermissions: true` is set as well.
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
