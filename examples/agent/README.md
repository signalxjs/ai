# agent — the `@sigx/ai-agent` playground

Open a session against any agent, on any model, in any mode — from the page,
not from `.env`. Open several at once and run the same prompt against Claude
Code, Codex and our own engine side by side. Switch a running session into
**plan mode**, or onto another model, from its Settings panel. No key and no
installed CLI needed to start.

## Quickstart

```sh
pnpm install
pnpm build                        # the example resolves the packages from dist/
pnpm --filter agent-example dev   # http://localhost:5320
```

```
agent dev  http://localhost:5320  (no keys — the scripted agents are always there)
            pick an agent, a model and a mode in the sidebar; open several at once to compare them
```

A `sigx` session on the scripted mock is open when the page loads. Type
*“any incidents?”*. Watch, in order:

1. `triage` starts a **sub-agent**, unasked — it only reads, so it is
   annotated `readOnly: true` and the session's policy is `allowReadOnly`.
   Its card opens under the tool call that spawned it, shows `running`, and
   streams its own work. While it runs, **Cancel** on the card stops that
   agent alone; the turn carries on without it.
2. `restart_service` **stops and asks**: the turn goes `awaiting`, the tool
   card grows an Allow / Deny prompt, and the turn continues on your answer.
3. The answer streams in, token by token.

Type while a turn runs: our engine can steer (`capabilities.steer`), so Send
stays next to Cancel and the message lands inside the running turn.

Now press **New session** and pick a different agent — or the same one on a
different model. Both appear in the sidebar with their state and mode; tick
**Show all side by side** to watch them answer the same question at once.

Every harness runs on your own login and needs its CLI installed and signed
in. One that cannot start says why, *in the form*, and is offered greyed out
with the reason on it — an explicit choice never silently becomes a different
agent:

```
Needs the "codex" CLI on PATH — install it (npm i -g @openai/codex) or point SIGX_AI_AGENT_COMMAND at it.
```

| Agent | Adapter | CLI | Passed through to the child |
|---|---|---|---|
| `sigx` | `modelAgent` on `@sigx/ai` | — | — (the API keys) |
| `mock` | `mockAgent` from `@sigx/ai-agent/testing` | — | — |
| `claude-code` | `@sigx/ai-agent-claude-code` | the SDK's bundled Claude Code | `ANTHROPIC_*`, `CLAUDE_CONFIG_DIR` |
| `codex` | `@sigx/ai-agent-codex` | `codex` (`npm i -g @openai/codex`) | `OPENAI_API_KEY`, `CODEX_HOME` |
| `copilot` | `@sigx/ai-agent-copilot` | the SDK's bundled Copilot CLI runtime (`copilot login` to sign in) | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_HOME` |
| `acp:gemini` | `@sigx/ai-agent-acp` | `gemini` (`npm i -g @google/gemini-cli`) | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| `acp:cursor` | `@sigx/ai-agent-acp` | `agent` (the Cursor CLI) | `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN` |
| `acp:claude-code` | `@sigx/ai-agent-acp` | `claude-agent-acp` (`npm i -g @agentclientprotocol/claude-agent-acp`) | `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR` |
| `acp:codex` | `@sigx/ai-agent-acp` | `codex-acp` (`npm i -g @agentclientprotocol/codex-acp`) | `OPENAI_API_KEY`, `CODEX_HOME` |
| `acp:copilot` | `@sigx/ai-agent-acp` | `copilot --acp` (`npm i -g @github/copilot`) | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_HOME` |

A harness child gets an allowlisted environment (`PATH`, `HOME`, proxy
variables, …) plus the vendor variables in the last column — nothing else.

**Nothing in the transcript view changes between them** — that is the point of
the contract. A key gives `sigx` real models to pick from; the harnesses run
on their own login and report their own models once they are up.

### Env vars are defaults now, not the law

`SIGX_AI_AGENT`, `SIGX_AI_PROVIDER`, `SIGX_AI_MODEL` and `SIGX_AI_CWD` choose
what the **form starts on** and what the first session opens with. Everything
after that is the UI's. `SIGX_AI_AGENT_COMMAND` still points a harness at a
specific executable.

```sh
cp .env.example .env             # then uncomment what you need
```

`.env` is gitignored; `.env.example` documents every var the example reads.

Production, and end to end without a browser:

```sh
pnpm --filter agent-example build && pnpm --filter agent-example start
pnpm --filter agent-example smoke   # two sessions, isolation, configure, late join, close
pnpm test examples/agent            # the view's render decisions, in the DOM
```

## Switching plan mode — and why there is no code for it

The Settings panel on a pane is **one loop over `view.config`**, one `<select>`
per option, and `view.configure({ [id]: value })` on change. That is all of it.

Plan mode on Claude Code is `permissionMode: 'plan'`. On an ACP agent it is
`mode`, whatever that agent calls its modes. On Codex it is `approvalPolicy`
plus `sandbox`. The panel knows none of those names: each adapter advertises
its own vocabulary in a `config` event and the UI renders what it is given.
**The moment a control here needs an `if` on the agent, the fix belongs in the
adapter.**

Two honest details the panel shows rather than hides:

- An agent that announces its settings only with the first turn — the
  scripted mock does — gets a fresh pane saying *“reports its settings after
  its first message”* instead of a panel that cannot work yet.
- An option with one value renders **disabled**, showing what is running. A
  dropdown offering one choice is a lie.

## What to look at

- **`src/catalog.ts`** — the agent list, install hints, session limit and the
  DTOs, shared by both sides. Deliberately *not* a `*.server.ts` module:
  `@sigx/vite` replaces one of those wholesale in the client build and a
  re-export cannot be stubbed, so the types the UI needs have to live
  somewhere the browser may import.
- **`src/agents.server.ts`** — the tools, the scripted models, the `triage`
  sub-agent, and one `createAgent(choice)` per agent. Nothing runs at import.
- **`src/registry.server.ts`** — the live sessions, and the agents hosting
  them. A map of `serveSession`s keyed by id, and a map of agents keyed by
  what they host, **refcounted** so a harness process outlives its first
  conversation and dies with its last. One `watch` loop per session tracks its
  state for the sidebar and, in its `finally`, reaps it — which is why there is
  no close endpoint.
- **`src/agent.server.ts`** — five endpoints and nothing else.
- **`src/App.tsx`** — the sidebar, the New-session form, and a pane per
  session. **`src/Session.tsx`** — one pane, and the config panel.
  **`src/Thread.tsx`** — the transcript itself, unchanged by the split.
- **`smoke.mjs`** — the playground as a test, no browser: importing the
  endpoints opens nothing, two sessions stay independent, `configure()` goes
  over the real wire, a stale id answers with a typed error, and closing one
  leaves the other running.

## The lesson worth copying

**The session is not in the browser.** A pane holds a *view* of a log that
lives elsewhere, addressed by `(epoch, seq)` — which is why switching sessions
in the sidebar, a second tab, a reconnect after a dropped connection and a
phone opened an hour later all converge on the same transcript without any of
them being special-cased. A permission prompt is an event with an id;
answering it is a command.

**Topology is the app's job, not the library's.** `serveSession` serves one
session and the wire envelope has no create/list/destroy verb — deliberately.
So the session id rides the *transport* (`{ send, events }`), never the
command, and the registry lives here. A real app routes on `rq.principal` in
exactly the same place.

## Things that will bite you

- **`useAgentSession` subscribes on mount, not in setup**, and captures its
  source there. Panes are therefore **keyed and hidden, never unmounted** — a
  reused pane would keep folding the session it first saw.
- **Branch on capabilities, never on `agent.id`.** Cancel comes from
  `view.capabilities?.cancel`, the config panel from `?.config`, Send-during-a-
  turn from `?.steer`.
- **Four sessions, not more.** Each holds an NDJSON `serverStream` open and an
  HTTP/1.1 browser allows about six sockets per origin; past that the command
  POSTs queue behind the streams and the page stops responding with nothing to
  show for it. A real app multiplexes one stream, or serves HTTP/2.
- **`connectSession({ bufferSize })` is not decoration.** Reloading a long
  session replays everything into that buffer *before* the pane mounts, and
  the default 2000 would have evicted the start by the time
  `useAgentSession` subscribes from `(0, 0)` — which throws, leaving an empty
  transcript.
- **A late answer is not an error.** `respond()` on a request the policy, a
  timeout or a cancel already settled resolves with no effect.
- **A closed session is gone.** Its event log goes with it, so a finished run
  is not replayable and does not appear in a new tab. Keeping finished runs
  readable is a small follow-up — `serveSession.close()` deliberately does not
  close the session — not a rewrite.

**Non-goals:** no auth, no rate limit, no persistence. A real app puts
`createServerApp({ authenticate, middleware: [rateLimit] })` in front of the
endpoints, keys sessions off `rq.principal`, passes it to `handleCommand` with
an `authorize` on `serveSession`, and persists `session.ref` plus a durable
`EventLogStore` instead of `memoryEventLog()`.

## Files

| File | What |
|---|---|
| `src/catalog.ts` | the agents, install hints, the session cap, and the DTOs both sides share |
| `src/agents.server.ts` | tools, scripted models, the `triage` sub-agent, `createAgent` / `sessionOptionsFor` |
| `src/registry.server.ts` | live sessions and their agents, refcounted; the watcher that reaps them |
| `src/agent.server.ts` | the five endpoints |
| `src/App.tsx` | sidebar, New-session form, one pane per session |
| `src/Session.tsx` | one pane: header, the config panel, transcript, composer |
| `src/Thread.tsx` | messages, parts, tool cards, sub-agent cards, permission prompts |
| `src/sessions.ts` | the browser's store: one `connectSession` client per session |
| `smoke.mjs` | the end-to-end check (`pnpm --filter agent-example smoke`) |
| `__tests__/app.test.tsx` | the view in the DOM: `Part` and the config panel |
| `vite.config.ts` | `sigx()` + `sigxServer()`; the client build swaps the server modules for stubs |
| `.env.example` | every env var the example reads; copy to `.env` |
