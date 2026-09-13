# chat — AI chat in a real SignalX app

One `serverStream` endpoint streams `UIChunk`s to `useChat`; the model runs
tools on the server; the provider is whatever the environment says; the
assistant's text renders as markdown through `RichTextView` from `@sigx/richtext/dom` (with `markdownFormat` from `@sigx/richtext-markdown`). No key
needed to run it.

## Quickstart

```sh
pnpm install
pnpm build                       # the example resolves the packages from dist/
pnpm --filter chat-example dev   # http://localhost:5310, scripted mock model
```

```
chat dev  http://localhost:5310  (provider: mock)
```

With a real model:

```sh
ANTHROPIC_API_KEY=sk-ant-… pnpm --filter chat-example dev      # Claude (claude-opus-5)
OPENAI_API_KEY=sk-…         pnpm --filter chat-example dev      # OpenAI (gpt-5)
SIGX_AI_PROVIDER=openai SIGX_AI_MODEL=gpt-5-mini pnpm --filter chat-example dev
```

Or put them in a file — `dev` and `start` both load `.env` (node's
`--env-file-if-exists`, so a missing file is fine):

```sh
cp .env.example .env             # then uncomment a key in it
```

`.env` is gitignored; `.env.example` documents every var the example reads
(`SIGX_AI_PROVIDER`, `SIGX_AI_MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PORT`).
Note that this is the example wiring it up, not the framework: nothing in sigx
loads `.env` for you today (signalxjs/cli#113).

Production:

```sh
pnpm --filter chat-example build
pnpm --filter chat-example start
```

## What to look at

- **`src/ai.server.ts`** — the whole server side: three tools (`defineTool`
  with a Zod schema; `send_email` has `needsApproval: true`), the model
  picked by env, and the endpoint: a `serverStream` whose body is
  `yield* chatStream(...)`. `ChatInput` validates the wire transcript;
  `rq.abortSignal` cancels the model call when the tab closes. Say "email"
  to see the approval flow: the turn stops `awaiting`, `App.tsx` renders
  Approve / Deny from `thread.approvals`, and `approve()` / `deny()` send
  the transcript back so the same assistant message resumes.
- **`src/App.tsx`** — `useChat({ stream: (input) => chat(input) })`, and a
  view that just reads `thread.messages`. Each part is its own reactive
  object, and a text part is `<RichTextView value={part.text} format={markdownFormat} />` from
  `@sigx/richtext/dom`: open devtools, send a message, and watch only the
  markdown block still being written update per token — finalized blocks
  (and the rest of the DOM) stay put.
- **`vite.config.ts`** — `sigx()` + `sigxServer()`. The client build swaps
  `ai.server.ts` for a stub, so neither SDK nor key reaches the browser.

**Non-goals:** no auth, no rate limit, no persistence. A real app puts
`createServerApp({ authenticate, middleware: [rateLimit] })` in front of the
stream — a model call costs money per request — and keeps the transcript in
an actor (`@sigx/ai-actors`, coming) rather than in the browser.

## The lesson worth copying

The transcript on the wire is **untrusted input** even though your own UI
produced it: `ChatInput` rejects unknown part types, bad roles and oversized
text before anything reaches the model. Bring your own Standard Schema to
add fields; keep the check.

## Things that will bite you

- **The tool's JSON Schema must exist at definition time.** `defineTool`
  throws immediately when it cannot derive one; this example passes
  `z.toJSONSchema(...)` explicitly so it does not depend on which Zod minor
  implements the Standard JSON Schema hook.
- **`useStream` keys** (used by `useCompletion`, not by this example) must be
  unique per request — two `useCompletion('answer', …)` on one page race.
- **A stopped turn keeps its partial message.** `stop()` aborts the request
  and the handler's `finally` runs; the assistant message stays in the
  transcript with what arrived. `regenerate()` drops it.

## Files

| File | What |
|---|---|
| `src/ai.server.ts` | tools, model selection, the `serverStream` endpoint |
| `src/App.tsx` | the chat view on `useChat`; assistant text through `RichTextView` |
| `src/entry-server.tsx` / `src/entry-client.tsx` | the per-request app factory / the hydrating browser entry |
| `src/env.d.ts` | Vite client types |
| `dev-server.mjs` / `server.mjs` | dev (Vite middleware) / production (Node) servers |
| `vite.config.ts` | `sigx()` + `sigxServer()` |
| `.env.example` | every env var the example reads; copy to `.env` |
| `index.html` | the shell and its CSS, including the `[data-scope=richtext][data-part=…]` rules the richtext view is styled by (it ships no CSS) |
| `tsconfig.json` | typechecks against the packages' SOURCE, so it works on a clean checkout |
