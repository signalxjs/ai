# agent — an `@sigx/ai-agent` session in a real SignalX app

One session lives on the server; `serveSession` exposes it; every tab
`connectSession`s to it and `useAgentSession` renders it. Tool cards,
permission prompts, cancel and usage — and a **second tab that joins the
same conversation**, replays it by sequence and then follows along. No key
needed to run it.

## Quickstart

```sh
pnpm install
pnpm build                        # the example resolves the packages from dist/
pnpm --filter agent-example dev   # http://localhost:5320, our engine on the scripted mock
```

```
agent dev  http://localhost:5320  (agent: sigx, model: mock)
            open it in two tabs — the second one replays the same session
```

Type *“any incidents?”*. Watch, in order:

1. `list_incidents` runs **unasked** — it is annotated `readOnly: true` and
   the session's policy is `allowReadOnly`.
2. `restart_service` **stops and asks**: the turn goes `awaiting`, the tool
   card grows an Allow / Deny prompt, and the turn continues on your answer.
3. The answer streams in, token by token.

Now open a second tab. It shows the whole conversation — replayed from
`(epoch 0, seq 0)` — and the next turn reaches both tabs live. Approve a
tool in one and the other updates.

With a real model, or a real harness:

```sh
ANTHROPIC_API_KEY=sk-ant-…     pnpm --filter agent-example dev   # our engine on Claude
OPENAI_API_KEY=sk-…            pnpm --filter agent-example dev   # our engine on OpenAI
SIGX_AI_AGENT=claude-code      pnpm --filter agent-example dev   # Claude Code itself
SIGX_AI_AGENT=codex            pnpm --filter agent-example dev   # Codex (`codex app-server`)
SIGX_AI_AGENT=acp:gemini       pnpm --filter agent-example dev   # Gemini CLI over ACP
SIGX_AI_AGENT=acp:cursor       pnpm --filter agent-example dev   # the Cursor CLI agent over ACP
SIGX_AI_AGENT=acp:claude-code  pnpm --filter agent-example dev   # Claude Code via Zed's ACP bridge
SIGX_AI_AGENT=acp:codex        pnpm --filter agent-example dev   # Codex via Zed's ACP bridge
```

Every harness runs on your own login. Each one needs its CLI installed and
signed in; when it is not, the example says which CLI is missing, how to
install it, and falls back to our own engine:

```
[agent] SIGX_AI_AGENT=codex needs the "codex" CLI on PATH — install it (npm i -g @openai/codex) or point SIGX_AI_AGENT_COMMAND at it; falling back to the sigx engine.
```

**Nothing in `App.tsx` changes either way** — that is the point of the
contract. A harness works in a directory: `SIGX_AI_CWD` (default: where you
started the server) is its session's `cwd`, and `SIGX_AI_AGENT_COMMAND`
points at a specific executable instead of the PATH lookup.

| `SIGX_AI_AGENT` | Adapter | CLI | Passed through to the child |
|---|---|---|---|
| `sigx` (default) | `modelAgent` on `@sigx/ai` | — | — (`SIGX_AI_PROVIDER`, `SIGX_AI_MODEL`, the API keys) |
| `claude-code` | `@sigx/ai-agent-claude-code` | the SDK's bundled Claude Code | `ANTHROPIC_*`, `CLAUDE_CONFIG_DIR` |
| `codex` | `@sigx/ai-agent-codex` | `codex` (`npm i -g @openai/codex`) | `OPENAI_API_KEY`, `CODEX_HOME` |
| `acp:gemini` | `@sigx/ai-agent-acp` | `gemini` (`npm i -g @google/gemini-cli`) | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| `acp:cursor` | `@sigx/ai-agent-acp` | `agent` (the Cursor CLI) | `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN` |
| `acp:claude-code` | `@sigx/ai-agent-acp` | `claude-code-acp` (`npm i -g @zed-industries/claude-code-acp`) | `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR` |
| `acp:codex` | `@sigx/ai-agent-acp` | `codex-acp` (`npm i -g @zed-industries/codex-acp`) | `OPENAI_API_KEY`, `CODEX_HOME` |

A harness child gets an allowlisted environment (`PATH`, `HOME`, proxy
variables, …) plus the vendor variables in the last column — nothing else.

The `SIGX_` prefix is deliberate: a bare `AI_AGENT` is generic enough that the
tooling you run this from may already define it (Claude Code does). Each
variable is validated against the values the server understands, so an
unrecognised one warns and the banner names the fallback it actually used.

Or put them in a file — `dev` and `start` both load `.env` (node's
`--env-file-if-exists`, so a missing file is fine):

```sh
cp .env.example .env             # then uncomment what you need
```

`.env` is gitignored; `.env.example` documents every var the example reads
(`SIGX_AI_AGENT`, `SIGX_AI_CWD`, `SIGX_AI_AGENT_COMMAND`, `SIGX_AI_PROVIDER`,
`SIGX_AI_MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PORT`) and the
vendor variables each harness passes through.

Production:

```sh
pnpm --filter agent-example build
pnpm --filter agent-example start
```

End to end, without a browser:

```sh
pnpm --filter agent-example smoke   # boots the server, runs one mock turn, joins late
```

## What to look at

- **`src/agent.server.ts`** — the whole server side. Two tools (`defineTool`
  with a Zod schema; `list_incidents` carries `annotations: { readOnly: true }`,
  which is what `allowReadOnly` reads), the agent picked by env (our engine
  or any harness adapter — one `switch`, the same `SESSION_OPTIONS` for all),
  one session opened with a policy, and `serveSession` — then two endpoints: a
  `serverFn` that takes wire commands and a `serverStream` that yields wire
  frames from the client's cursor. Deliberately **one process-wide session**,
  so the second tab is a late joiner rather than a new conversation.
- **`src/App.tsx`** — `connectSession` over the two build-swapped stubs, then
  `useAgentSession(session)` and a view that just reads the transcript. A
  token is one write to one part's `text`: open devtools and watch only that
  text node update. Permission prompts render **on the tool card** they
  belong to, from `part.requestId` → `view.requests`.
- **`vite.config.ts`** — `sigx()` + `sigxServer()`. The client build swaps
  `agent.server.ts` for stubs, so neither the agent, nor the policy, nor a
  key reaches the browser.
- **`smoke.mjs`** — the example as a test: boot the dev server, load the real
  endpoints, drive one turn through `connectSession`, answer the permission
  request, then connect a second client and assert both transcripts match.

**Non-goals:** no auth, no rate limit, no persistence, one shared session. A
real app puts `createServerApp({ authenticate, middleware: [rateLimit] })` in
front of both endpoints, opens a session per principal, passes
`rq.principal` to `handleCommand` with an `authorize` on `serveSession`, and
persists `session.ref` plus a durable `EventLogStore` instead of
`memoryEventLog()`.

## The lesson worth copying

**The session is not in the browser.** The page holds a *view* of a log that
lives elsewhere, addressed by `(epoch, seq)` — which is why a second tab, a
reconnect after a dropped connection, and a phone opened an hour later all
converge on the same transcript without any of them being special-cased. A
permission prompt is an event with an id; answering it is a command. Nothing
in the UI is stateful except the draft in the textarea.

The corollary: **unmounting a view must not close the session.**
`useAgentSession` unsubscribes on unmount and leaves the session alone — a
turn still running carries on, and nothing it does afterwards reaches the
gone view. The connection belongs to whoever opened it (here, `App` closes it
in `onUnmounted`).

## Things that will bite you

- **`useAgentSession` subscribes on mount, not in setup.** A server render
  must not open a subscription it cannot close, so SSR paints the shell and
  the browser replays from `(0, 0)`. Expect an empty transcript in the SSR
  HTML — that is correct.
- **Branch on capabilities, never on `agent.id`.** The Cancel button is
  rendered from `view.capabilities?.cancel`, so an agent that cannot cancel
  simply does not offer it.
- **A late answer is not an error.** `respond()` on a request the policy, a
  timeout or a cancel already settled resolves with no effect — two tabs may
  race to approve the same tool, and that is fine.
- **Without an `eventLog`, a cursor that has fallen out of the in-memory
  buffer gets a `gap` frame**, and the client resets to the head. This
  example passes `memoryEventLog()` so a long conversation still replays.

## Files

| File | What |
|---|---|
| `src/agent.server.ts` | tools, agent selection, the session, `serveSession`, and the two endpoints |
| `src/App.tsx` | `connectSession` + `useAgentSession`; tool cards, permission prompts, cancel, usage |
| `src/entry-server.tsx` / `src/entry-client.tsx` | the per-request app factory / the hydrating browser entry |
| `src/env.d.ts` | Vite client types |
| `dev-server.mjs` / `server.mjs` | dev (Vite middleware) / production (Node) servers |
| `smoke.mjs` | end-to-end check: boot, one mock turn, a late joiner (`pnpm --filter agent-example smoke`) |
| `vite.config.ts` | `sigx()` + `sigxServer()` |
| `.env.example` | every env var the example reads; copy to `.env` |
| `index.html` | the shell and its CSS |
| `tsconfig.json` | typechecks against the packages' SOURCE, so it works on a clean checkout |
