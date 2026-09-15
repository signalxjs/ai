# @sigx/ai-agent-acp

> **Experimental** — 0.x, part of the `@sigx/ai-agent` family (see
> [signalxjs/ai#35](https://github.com/signalxjs/ai/issues/35)).

Every agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com)
as an `@sigx/ai-agent` `Agent` — Gemini CLI, Cursor, Claude Code and Codex
through their ACP bridges, and whatever ships ACP support next. One adapter;
vendors are presets (a command line and the environment variables to pass).

```ts
import { allowReadOnly, firstMatch } from '@sigx/ai-agent';
import { denyOutside } from '@sigx/ai-agent/coding';
import { acp, gemini } from '@sigx/ai-agent-acp';

const agent = acp(gemini());                       // spawns `gemini --experimental-acp`
const session = await agent.session({
    cwd: process.cwd(),
    interactive: false,
    policy: firstMatch(denyOutside(process.cwd()), allowReadOnly)
});
const turn = session.prompt('Summarise this repository.');
for await (const event of turn) {
    if (event.type === 'part-delta') process.stdout.write(event.delta);
}
console.log((await turn.result).stopReason);      // 'end_turn'
await agent.dispose();                             // kills the agent process tree
```

## What you get

- `acp({ command, args?, env?, cwd?, transport?, fs?, terminal?, passEnv?, clientInfo?, id? })`
  → an `AcpAgent`: the `Agent` contract plus `connect()` (spawn + `initialize`)
  and `init` (the raw `initialize` response). `transport: { readable, writable }`
  drives an agent that is already running (a socket, a fake in tests) without
  spawning anything.
- **Honest capabilities.** Before `connect()` the agent claims only what every
  ACP agent can do (`cancel`, `permissions: 'harness-filtered'`); afterwards
  `capabilities` reflects what the agent advertised: `resume: 'local'` when it
  supports `session/resume` or `session/load`, `fork`, `listSessions`,
  `promptParts` from its prompt capabilities, `tools: 'mcp'` when it accepts
  HTTP MCP servers. What is not advertised is refused up front, never sent
  and silently misread: a prompt part outside the negotiated `promptParts`,
  `prompt(input, { output })` (ACP has no structured output —
  `structuredOutput: false`) and `configure()` on a key the session never
  advertised all end with a `protocol_error` — which names what it does
  advertise. `steer` and sub-agents
  are `false` / `'none'`: the protocol has no surface for them.
- **Client tools** (`session({ tools })`) are served over MCP by
  `createMcpToolHandler` + `listenMcp` — loopback, a per-session bearer token —
  and handed to the agent in `session/new`. An agent that cannot take HTTP MCP
  servers refuses tools loudly rather than dropping them.
- **Permissions.** `session/request_permission` runs through the session
  policy (`resolveRequest`): an `allow` picks `allow_once` / `allow_always`
  (session-scoped grants pick `allow_always`), a deny picks `reject_once`, a
  cancelled turn answers `cancelled`. A headless session with no policy denies.
- **Coding events.** Tool calls carry the ACP `kind` as their `category`;
  `diff` content becomes `coding.diff`, plans become `coding.plan`, usage
  updates become session `usage`, mode and config changes become `config`
  (drive them with `session.configure({ mode, ...options })`). `mode` always
  means the ACP *session* mode; an agent that declares a config option of its
  own called `mode` gets it under `acp:mode`. Two options are never advertised
  under one id — `id` is what `configure()` addresses. Our own label is the
  only one we rewrite: when an agent declares an option it also calls "Mode",
  ours becomes "Session mode", so those two are not both labelled `Mode`.
  Labels an agent gives its *own* options are left alone, so it can still
  render two of them alike if it chooses to.
- **Resume and history.** The `SessionRef` names the ACP session and its
  `cwd`; resuming uses `session/resume` when advertised and otherwise
  `session/load`, whose replayed history lands in the new epoch as plain
  transcript events.

## The fs / terminal opt-in

An ACP agent may ask the client to read and write files and run commands.
Both are **off** unless you turn them on, and both go through two gates:

```ts
const agent = acp({ ...cursor(), fs: { read: true, write: true }, terminal: true });
```

1. The path (or the terminal's `cwd`) must lie inside the session's `cwd` or
   `additionalDirectories` — `denyOutside` semantics, Windows drives and UNC
   shares included.
2. The session policy is asked like for any tool: `fs/read_text_file`
   (`category: 'read'`), `fs/write_text_file` (`edit`), `terminal/create`
   (`execute`), all `source: 'client'`. The `permissionKey` names the target
   (`fs/read_text_file:<absolute path>`, `terminal/create:<command>`), so a
   session-scoped "allow" grants that file or command — never the whole fence.
   Terminals run through
   `spawnAgentProcess` (allowlisted environment, never a shell) with a bounded
   output buffer and stream `coding.terminal` events.

## Presets

| Preset | Command | Install | Passes |
|---|---|---|---|
| `gemini()` | `gemini --experimental-acp` | `npm i -g @google/gemini-cli` | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| `cursor()` | `agent acp` | [cursor.com/install](https://cursor.com/install), below | `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN` |
| `claudeCodeAcp()` | `claude-agent-acp` | `npm i -g @agentclientprotocol/claude-agent-acp` | `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR` |
| `codexAcp()` | `codex-acp` | `npm i -g @agentclientprotocol/codex-acp` | `OPENAI_API_KEY`, `CODEX_HOME` |
| `copilotAcp()` | `copilot --acp` | `npm i -g @github/copilot` | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_HOME` |

The Cursor CLI is the one that does not come from npm — its install line has a
pipe in it, so it lives here rather than in a table cell:

```sh
curl https://cursor.com/install -fsS | bash
```

The two bridges moved out of `@zed-industries`, where both packages are now
deprecated. The Claude one renamed its command with the move
(`claude-code-acp` → `claude-agent-acp`); the Codex one kept `codex-acp` and
only changed the package you install. A preset name says which *agent* it
runs, so both keep theirs — to stay on a deprecated bridge, override the
command: `acp(claudeCodeAcp({ command: 'claude-code-acp' }))`.

A preset is a plain object — override any field: `acp(gemini({ command: '/opt/gemini' }))`.
Adding one is adding an object: `{ id: 'acp:<vendor>', command, args, passEnv }`.
The adapter never collects credentials; the agent uses whatever it is signed
in with, or the variables you pass. When an agent requires authentication it
throws `AgentError('auth_required')` with the advertised auth methods in `data`.

## Install

```bash
npm install @sigx/ai @sigx/ai-agent @sigx/ai-agent-acp
# plus the agent itself, e.g.
npm install -g @google/gemini-cli
```

Peers on `@sigx/ai` and `@sigx/ai-agent` at the same minor; depends on
`@sigx/ai-agent-node` for the process work. Node 20.19+ (Windows, macOS, Linux).

## Documentation

Guides and the contract reference: **<https://sigx.dev/ai/>**

## License

MIT © Andreas Ekdahl
