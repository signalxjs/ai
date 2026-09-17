# SignalX ai — shared agent guide

> ⚠️ **BRANCH FIRST — never work on `main`.** Before touching ANY file, create a
> worktree (`pnpm wt new <N-short-slug>`) and do everything from
> `<repo>/branches/<N-short-slug>`. This applies to every change, however small —
> editing or committing in the primary checkout (`<repo>/main`) causes conflicts
> for parallel sessions. Check yourself before every commit:
> `git branch --show-current` must print your worktree's branch name — if it
> prints `main` or nothing (detached HEAD), stop.
> Already edited files in `main` by mistake? Move the work, don't commit it:
> `git stash -u` → `pnpm wt new <N-short-slug>` →
> `cd <repo>/branches/<N-short-slug>` → `git stash pop`.

Canonical guidance for **any** AI agent working in this repo (Claude Code, GitHub
Copilot CLI, work agents, …). Tool-specific notes live in `CLAUDE.md`; it defers
here for everything shared — when it conflicts with this file, the tool-specific
file wins for that tool only.

This is the sigx standard agent setup. The same pattern (this file +
`scripts/worktree.mjs` + a thin tool-specific file) is used across sigx repos —
it originates in [`signalxjs/repo-template`](https://github.com/signalxjs/repo-template).
See "Adopting this setup in another sigx repo" at the bottom.

SignalX AI (`signalxjs/ai`) is the home of `@sigx/ai` — AI for SignalX:
a provider-neutral streaming core (the `LanguageModel` seam, the `UIChunk`
wire protocol, `defineTool`, the tool loop), the `useChat` /
`useCompletion` / `useObject` composables on `@sigx/runtime-core`, and one
provider package per vendor on that vendor's OFFICIAL SDK. A pnpm workspace
(ESM, `"type": "module"`) with the published packages under `packages/` and a
runnable demo under `examples/`. Tech stack: TypeScript (strict), Vite,
Vitest (happy-dom), oxlint. Published to npm under the `@sigx` scope.
<!-- Single-package repo? Say so here ("…is a single npm package, not a workspace")
     and drop the workspace/`--filter` bits from "Build, Test, Lint" and "Packages". -->

## Development workflow (issue → PR → Copilot review → merge)

**This is mandatory for EVERY agent-driven change — including one-line fixes.
Never commit straight to `main`.** Repo: `signalxjs/ai`, base branch `main`.
(Human contributors follow `CONTRIBUTING.md`, where an issue is optional; for
agents the issue-first flow below is required.)

1. **Issue first.** If no GitHub issue already tracks the work, create one *before*
   writing code and put the plan in it:
   ```sh
   gh issue create --title "<concise title>" --body "<what & why, plus the plan/checklist>"
   ```
   If you worked in plan mode, the approved plan **is** the issue body. Note the
   number it returns (`#N`).

2. **Worktree, always.** Never work on `main`. Use the worktree flow (below):
   `pnpm wt new <N-short-slug>` gives an isolated checkout on branch
   `<N-short-slug>`. Don't substitute `git switch -c` in the primary checkout —
   it occupies `<repo>/main`, which parallel sessions share.

3. **Implement & verify.** For a **bug fix, write a failing unit test that
   reproduces the bug *first*** (red), then make the fix so that test passes
   (green) — see "Test-first bug fixes" under Conventions. Either way, prove the
   change: `pnpm typecheck` (always, for any `.ts`) plus the relevant `pnpm test`
   / `pnpm build`. Stage specific files (`git add <path>`), never `git add -A`.
   No co-author trailers.

4. **Open a PR with Copilot as the reviewer.** Reference the issue so it auto-closes
   on merge:
   ```sh
   gh pr create --base main --title "<title>" \
     --body "Closes #N. <short summary of the change>" --reviewer @copilot
   ```
   The PR description becomes the squash commit **body** verbatim, and the PR
   title (with ` (#<pr>)` appended) becomes its subject — see step 6. Write the
   description as the commit body you want on `main`.
   (On an already-open PR: `gh pr edit <pr> --add-reviewer @copilot`.) The bot
   `copilot-pull-request-reviewer` posts its review within a minute or two. If your
   `gh` is too old to resolve `@copilot` (error: `'@copilot' not found`), request it
   via the API instead — don't skip it:
   ```sh
   gh api --method POST repos/signalxjs/ai/pulls/<pr>/requested_reviewers \
     -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
   ```
   (The reviewer-request API takes the `[bot]`-suffixed slug; the review author
   login in `.reviews[].author.login` appears *without* the suffix.)

5. **Wait for Copilot's review, then fix.** Do not merge before it has reviewed. Poll
   until a review by the bot appears, then read it:
   ```sh
   gh pr view <pr> --json reviews -q '.reviews[].author.login'   # wait for "copilot-pull-request-reviewer"
   gh pr view <pr> --json reviews,comments
   ```
   Address every actionable comment with follow-up commits and push. If the review
   doesn't re-trigger on its own, re-request it: `gh pr edit <pr> --add-reviewer @copilot`.
   Repeat until Copilot has no remaining actionable feedback.

   **Then resolve the threads.** Where the repo's ruleset sets
   `required_review_thread_resolution` (check with
   `gh api repos/signalxjs/ai/rules/branches/main`), a PR carrying an
   unresolved **inline** comment cannot merge however green it is — with a
   merge queue it silently never enqueues, and `gh pr checks` shows nothing
   wrong. Pushing the fix does not resolve a thread, and neither does replying
   at PR level. There is no `gh pr` porcelain — reply on each thread and
   resolve it over GraphQL:
   ```sh
   # list the open threads
   gh api graphql -f query='query { repository(owner:"signalxjs", name:"ai") {
     pullRequest(number:<pr>) { reviewThreads(first:100) { nodes {
       id isResolved comments(first:1){nodes{body}} } } } } }' \
     -q '.data.repository.pullRequest.reviewThreads.nodes[]
         | select(.isResolved==false) | "\(.id) \(.comments.nodes[0].body[0:60])"'

   # reply (say which commit fixed it), then resolve — pass the body as a
   # GraphQL variable, not string-interpolated: quotes and backslashes in a
   # review reply otherwise break the query
   gh api graphql -f query='mutation($t:ID!,$b:String!){
     addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t, body:$b}){ comment { id } } }' \
     -f t="<thread-id>" -f b="Fixed in <sha>. <what changed>"
   gh api graphql -f query='mutation($t:ID!){
     resolveReviewThread(input:{threadId:$t}){ thread { isResolved } } }' -f t="<thread-id>"
   ```

6. **Merge it yourself.** Once Copilot's feedback is resolved, CI is green, and —
   for user-facing changes — the docs issue is filed on the docs repo and linked
   from the PR (see "Documentation"), merge (squash — repo rules block merge
   commits) and clean up:
   ```sh
   pr=123                                     # your PR number (digits only)
   gh pr checks "$pr"                         # must be all green first
   gh pr merge "$pr" --squash --delete-branch \
     --subject "$(gh pr view "$pr" --json title -q .title) (#$pr)" \
     --body "$(gh pr view "$pr" --json body -q .body)"
   ```
   Pass `--subject`/`--body` explicitly, exactly as above — GitHub appends
   `Co-authored-by:` trailers to every message it generates itself (in **all**
   squash-message modes, even PR_TITLE/PR_BODY) whenever a branch-commit author
   differs from the merging account; an explicit message is used verbatim, so
   no trailers. If you used a worktree, remove it afterward: `pnpm wt rm <name>`.

## Build, Test, Lint


```bash
pnpm install
pnpm build       # every published package, dependency order (core first)
pnpm test        # vitest run (unit tests across packages, plus any examples/*/__tests__)
pnpm test <path>                   # single test file/dir (substring match)
pnpm test -t "name of test"        # single test by name (vitest -t)
                                   # NB: no `--` — vitest discards operands
                                   # after it, so `pnpm test -- x` silently
                                   # runs the WHOLE suite. pnpm forwards
                                   # args natively; the `--` is npm-only.
pnpm test:watch
pnpm test:coverage
pnpm test:scripts   # node:test suites for the release/tooling scripts under scripts/
pnpm typecheck   # tsc (TypeScript 7, the native compiler) over the packages, then the example against its own tsconfig
pnpm lint        # oxlint over the packages' and example's src
pnpm lint:fix
pnpm size        # size-limit bundle-size check (.size-limit.json)
pnpm verify:catalog # every core dep flows through the single-minor catalog
pnpm verify:pack    # pack every published package and import it from a scratch app
```

Provider tests run against RECORDED fixtures — no network, no key. A live
smoke test per provider is env-gated (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
and skips with a printed reason otherwise.

To run an example: `pnpm build` first (they resolve the packages from
`dist/` through the workspace link), then `pnpm --filter chat-example dev` or
`pnpm --filter agent-example dev`. The agent example also has an end-to-end
check that needs no browser — `pnpm --filter agent-example smoke` (CI runs it
on every OS in the matrix).

## Packages

**Naming rule.** A package name says which contract it implements first, and
what it talks to second. Three tiers:

- `@sigx/ai-<vendor>` — a `LanguageModel` on a vendor's inference API, named by
  **who you authenticate to**: `ai-anthropic`, `ai-openai` (a Gemini one would
  be `ai-google`, not `ai-gemini` — Gemini is the model family, not the API you
  hold a key for). One vendor, one package.
- `@sigx/ai-agent-<protocol>` — one `Agent` adapter serving many harnesses over
  a standard protocol, named by the protocol: `ai-agent-acp`.
- `@sigx/ai-agent-<product>` — one `Agent` adapter for one agent product, named
  as its users name it: `ai-agent-claude-code`, `ai-agent-codex-cli`,
  `ai-agent-copilot-cli`.

The two agent tiers key on the **product**, not the vendor, because the
cardinality differs: a vendor has one inference API but ships several agent
products (Copilot CLI *and* the cloud coding agent; Codex CLI *and* Codex
cloud). A bare vendor word would be wrong the moment the second one lands, so
add the qualifier the product's own users say — `-cli` — unless the product
name is already unambiguous (`claude-code` is; `copilot` is not). Name by the
product, never by the SDK we link against: `@github/copilot-sdk` *is* the
Copilot CLI, and SDK names move under us (`@anthropic-ai/claude-code` →
`@anthropic-ai/claude-agent-sdk`). Transport is an option inside the package,
not a name.

Vendor-first grouping (`ai-anthropic-agent-claude-code`) is deliberately NOT
used: it scatters the agent family alphabetically, has no segment for a
protocol adapter, double-encodes (Claude Code can only be Anthropic's), and
demotes the contract seam the whole layer exists to provide. Vendor grouping
for discovery is what the `@sigx` scope, `keywords` and the README table are
for. `ai-agent-node` is infrastructure — a documented exception in the product
slot.

The factory mirrors the package name (`acp()`, `claudeCode()`, `codexCli()`,
`copilotCli()`), so two adapters for one vendor never export the same symbol.
The agent's default `id` and its `ext` namespace use that same string
(`'codex-cli'`), since both reach session refs and persisted transcripts.

- `packages/ai` → `@sigx/ai` — the core. Five entries: `.` (the
  `LanguageModel` seam, `UIMessage`/`UIPart` and the `UIChunk` stream
  protocol, `defineTool`, `streamText` / `generateText` / `streamObject` —
  the tool loop, message assembly and abort handling live HERE, once;
  providers only translate), `./server` (`chatStream` — the generator a
  `serverStream` handler delegates to, plus `toTextStream` for
  `useStream`), `./app` (`useChat`, `useCompletion`, `useObject` —
  composables on `@sigx/runtime-core`, NEVER the `sigx` umbrella, so a
  terminal or Lynx app can use them), `./testing` (`mockModel` — a
  scripted, deterministic model for tests, docs and CI), and `./ui`
  (`uiTool` — a `@sigx/json-ui` spec as a tool the model calls, whose
  description is the catalog; `@sigx/json-ui` is an optional peer that
  only this entry needs). Zero runtime dependencies; `node:`-free so the
  deploy adapters (workerd, edge) run it.
- `packages/json-ui` → `@sigx/json-ui` — **proof of concept**, UI from JSON: a
  JSON UI spec anything can write and stream — a model, a server, a CMS —
  rendered wherever sigx renders. No dependency on `@sigx/ai` (the two
  helpers it shares with the core, `parsePartialJson` and the Standard
  Schema types, are copies); the model-facing tool lives on `@sigx/ai/ui`.
  Entries: `.` (the spec types, a safe JS-subset expression language with its
  own parser — `{"$": "expr"}` values and `{{expr}}` interpolation, no
  `eval`, lazy helpers with `it` instead of lambdas — `defineCatalog` and
  the 8-component `baseCatalog`, `validateSpec` / `uiSpecSchema` /
  `specJsonSchema` / `describeCatalog`, the `applyUIChunk` stream reducer
  with identity-preserving `mergeDeep`, the async action runtime — `state.*`,
  `http`, `delay`, `emit`, `call`, `seq`, `all`, `ui.patch`, host actions,
  per-node concurrency modes); `./app` (`UIView`, `createUIRuntime` on
  `@sigx/runtime-core`, NEVER the `sigx` umbrella: one keyed `UINodeView`
  per spec node so a streamed token re-renders one node; runtime state is
  seeded from `spec.state` once and owned by the runtime); `./web` (the base
  catalog as `jsx('div' | 'span' | …)` functions, `webStyles`). Source
  layout: `utils ← spec ← expr ← catalog ← stream ← actions`, `app` and
  `web` on top. No JSX syntax in `src/` — `jsx()` calls with string tags, so
  no platform's `IntrinsicElements` is ever imported and a Lynx pack is the
  same functions over `view` / `text`. Node-free (edge-safety test). Peers
  on `@sigx/reactivity` and `@sigx/runtime-core` only, so it builds first.
  The chat example is the playground: its `render_ui` tool part (from
  `@sigx/ai/ui`) renders a `UIView` while the arguments stream.
- `packages/ai-agent` → `@sigx/ai-agent` — **experimental**, the agent layer
  (tracking issue #35): one provider-neutral `Agent` contract for agent
  harnesses and our own engine. Entries today: `.` (the contract, the
  `AgentEvent` union with `(epoch, seq)` stamps, `AgentCapabilities`, the
  policy engine `resolveRequest` + built-in rules, and the session helpers
  every adapter builds on — `createEventLog`, `createTurn`,
  `createSessionCore`) and `./testing` (`mockAgent`, a scripted agent).
  `./coding` adds the coding vocabulary (categories, typed `coding.*` events
  and their reducer plugin, path-aware policies); `./harness` is the edge-safe
  protocol kit protocol adapters build on: a JSON-RPC 2.0 peer over Web
  Streams (`createJsonRpcPeer`), NDJSON framing, an MCP tool handler
  (`createMcpToolHandler`, Streamable HTTP, tools only) and `webSocketStreams`;
  `./testing` also ships `recordAgent` / `replayAgent`. `./wire` serves a
  session in one place and uses it from another over any transport
  (`serveSession` / `connectSession`, a versioned envelope, replay for late
  joiners and reconnects). `./app` is `useAgentSession(source, options?)` —
  the session as reactive state on `@sigx/runtime-core` (NEVER the `sigx`
  umbrella): the transcript folded in place so a delta writes one part's
  `text`, subscription on mount (SSR-safe) and unsubscribe on unmount without
  closing the session, late join by replay from `{ epoch: 0, seq: 0 }`, and
  the same reducer `extensions`. Zero
  runtime dependencies; edge-safe (`node:`-free, no `process` / `Buffer`,
  enforced by `__tests__/package/edge-safety.test.ts`). Peers on `@sigx/ai` —
  plus `@sigx/reactivity` and `@sigx/runtime-core`, which only `./app` uses.
  Node-only building blocks live in `@sigx/ai-agent-node`; adapters follow
  the naming rule at the top of this section.
- `packages/ai-agent-node` → `@sigx/ai-agent-node` — **experimental**, the
  family's only Node-specific package (`tsconfig` `types: ["node"]`): it owns
  cross-platform process correctness — `resolveExecutable` (`PATH`/`Path`,
  `PATHEXT`, npm `.cmd` shims run under `process.execPath`),
  `spawnAgentProcess` (never `shell: true`; Web Streams stdio; process-group /
  `taskkill /T` kill; children die with the parent), `buildChildEnv` (an
  allowlist, `NODE_OPTIONS` excluded) and `listenMcp` (loopback `node:http`
  host for the harness MCP tool handler). Adapters that spawn a harness take
  it as a regular `dependencies` entry. Tested on Ubuntu, Windows and macOS.
- `packages/ai-agent-acp` → `@sigx/ai-agent-acp` — **experimental**, the Agent
  Client Protocol adapter (Node-only; depends on `@sigx/ai-agent-node` for the
  stdio path): `acp({ command, transport?, fs?, terminal? })` → an `Agent` with
  `connect()`; vendors are data-only presets (`gemini()`, `cursor()`,
  `claudeCodeAcp()`, `codexAcp()`, `copilotAcp()`). Layout `schema ← options ← client-methods
  ← stream ← session ← provider ← presets ← index`; `schema.ts` is our own
  protocol subset (the reference SDK is a devDependency for an assignability
  test only). Tests run against an in-memory fake agent over
  `createJsonRpcPeer`; live smokes are env-gated per preset.
- `packages/ai-agent-claude-code` → `@sigx/ai-agent-claude-code` — **experimental**,
  Claude Code as an `Agent` on the official `@anthropic-ai/claude-agent-sdk`
  (peer, literal range). Layout `options ← request ← permissions ← tools ←
  stream ← provider ← index`: one `query()` per session with a streaming
  prompt, `canUseTool` → `resolveRequest`, client tools over HTTP MCP
  (`createMcpToolHandler` + `listenMcp`), spawning through
  `@sigx/ai-agent-node` (a regular dependency), `system/init` → `config`,
  `result` → `usage` + `turn-end`. Thinking is `{ type: 'adaptive', display:
  'summarized' }` by default (the SDK's own default is `omitted`, which leaves
  reasoning parts empty); `configure({ thinkingDisplay })` switches it live. Tests replay recorded SDK messages through
  a fake `query` injected via `claudeCode({ query })`; a live smoke is gated on
  `SIGX_LIVE_CLAUDE_CODE=1`.
- `packages/ai-agent-codex-cli` → `@sigx/ai-agent-codex-cli` — **experimental**, the
  Codex CLI as an `Agent` over the `codex app-server` JSON-RPC protocol (one process and
  one `createJsonRpcPeer` per agent through `@sigx/ai-agent-node`, a regular
  dependency; `transport: { readable, writable }` drives a running server). One
  file per concern: `schema.ts` (the hand-written v2 subset, checked against the
  generated types in `__tests__/schema.test-d.ts`), `options.ts`, `approvals.ts`,
  `tools.ts` (dynamic tools), `stream.ts` (items → events), `session.ts`
  (a thread), `provider.ts` (`codexCli()`), `index.ts`. `pnpm --filter
  @sigx/ai-agent-codex-cli codex:generate` regenerates the full types with an
  installed Codex CLI.
- `packages/ai-agent-copilot-cli` → `@sigx/ai-agent-copilot-cli` — **experimental**,
  GitHub Copilot CLI as an `Agent` on the official `@github/copilot-sdk`
  (peer, literal range; the SDK spawns its bundled runtime itself, so no
  `@sigx/ai-agent-node`). Layout `options ← request ← permissions ← tools ←
  stream ← session ← provider ← index`: one `CopilotClient` per agent, one
  Copilot session per session created with OUR session id and its `onEvent` /
  `onPermissionRequest` / `onUserInputRequest` / `tools` wired before
  creation, `send()` … `session.idle` as a turn, in-process client tools
  (`tools: 'native'`), `listModels()` + `session.start` → a switchable
  `model` config option, `setModel` on `configure()`. Tests script the SDK
  boundary through `copilotCli({ client })` (`__tests__/fake-client.ts`);
  `__tests__/sdk.test-d.ts` checks the real `CopilotClient` / `CopilotSession`
  against that seam; a live smoke is gated on `SIGX_LIVE_COPILOT=1`.
- `packages/ai-anthropic` → `@sigx/ai-anthropic` — Claude on the official
  `@anthropic-ai/sdk` (a peer dependency, literal range): `anthropic()` →
  `.model(id)`. Streams `client.messages.stream`, maps text / thinking /
  tool-use blocks and `stop_reason` (incl. `refusal`) onto `ModelEvent`.
  Adaptive thinking is the default; `providerOptions` passes through
  `output_config`, `fallbacks`, `betas`, `thinking`.
- `packages/ai-openai` → `@sigx/ai-openai` — OpenAI on the official
  `openai` SDK (peer, literal range): `openai()` → `.model(id)` over the
  Responses API stream, function calling mapped onto tool events.
- `examples/chat` → `chat-example` — the **`@sigx/ai` playground**: an SSR
  sigx app with the provider and model picked in the page, per conversation.
  `src/catalog.ts` is the model list AND the server's allowlist (one table, so
  the picker cannot offer what the endpoint would refuse); `src/ai.server.ts`
  holds the `serverStream` chat endpoint, a `catalog` `serverFn` that serves
  only the providers whose key is set, and a `ChatRequest` schema that runs
  `ChatInput` over `messages` unchanged and checks the selection against the
  allowlist — it arrives from the browser, so it is attacker-controlled.
  `useChat` gets the selection through its `stream` callback (its input is
  `{ messages }` only), so no package change. `mockModel` when no key is set so
  it runs out of the box; the env vars choose the picker's starting point.
  `__tests__/app.test.tsx` mounts the exported `ModelPicker` and asserts what
  reaches the wire. Not published.
- `examples/agent` → `agent-example` — the **`@sigx/ai-agent` playground**: an
  SSR sigx app where sessions are opened from the UI against any agent, model
  and mode, several at once, and compared side by side. `src/catalog.ts` is
  the agent list and the DTOs both sides share (deliberately not a
  `*.server.ts` — the client build stubs those wholesale);
  `src/agents.server.ts` builds one agent per choice; `src/registry.server.ts`
  holds the live sessions and their agents, refcounted so a harness process
  outlives its first conversation and dies with its last, with one watcher per
  session that reaps it when it ends (which is why there is no close
  endpoint — the wire's own `close` command does it); `src/agent.server.ts` is
  five endpoints (`agentCatalog`, `agentSessions`, `agentOpenSession`, and the
  two wire ones keyed by `sessionId`, which rides the transport envelope, never
  the wire command). `src/App.tsx` is the sidebar and a pane per session,
  `src/Session.tsx` one pane plus the config panel — one `<select>` per
  `ConfigOption`, which is how plan mode is switched on every adapter with no
  per-adapter branching — and `src/Thread.tsx` the transcript itself. Env vars
  are the form's defaults, not the law. `smoke.mjs` is the whole thing without
  a browser: importing opens nothing, two sessions stay independent,
  `configure()` goes over the real wire. `__tests__/app.test.tsx` mounts `Part`
  and `ConfigPanel` and asserts the DOM — render decisions live only here, so
  the packages cannot cover them. Not published.

Path aliases: `tsconfig.json` and `vitest.config.ts` map `@sigx/ai` (and
its subpaths) and the provider packages to `packages/*/src`, so tests and
typecheck run against source, not dist. A new entry or package is added to
BOTH maps (plus `examples/chat/tsconfig.json` and
`examples/agent/tsconfig.json`), to `.size-limit.json`, to the root
`build`/`lint`/`typecheck` scripts, and to `scripts/lib/packages.mjs` — the
one list of published packages (`PACKAGES`, dependency order) and runtime
entries (`ENTRIES`) that `scripts/publish.js` and `scripts/verify-pack.js`
import. `scripts/lib/packages.test.mjs` (run by `pnpm test:scripts`) checks
that list and `.size-limit.json` against every `package.json`, so a missed
place fails CI rather than a release.

Source layout (`packages/ai/src`):

- **One folder per concern; its `index.ts` is the folder's public surface.**
  `protocol/` (the UI wire protocol), `model/` (the provider seam),
  `schema/`, `tool/`, `engine/` (the tool loop), `server/`, `app/`,
  `testing/`, `utils/`. Cross-folder imports go through
  `../<folder>/index.js`; inside a folder, siblings import each other
  directly. A file a folder's `index.ts` does not re-export (say
  `engine/abort.ts`) is private to that folder.
- **Imports point one way**:
  `utils ← schema ← protocol ← model ← tool ← engine ← server`; `app/` and
  `testing/` sit on top and nothing imports from them. No cycles.
- **Every entry point is a folder** — `src/index.ts` for `.`,
  `src/<entry>/index.ts` for a subpath — and those files are re-exports
  only, never implementation. `tsc` mirrors the tree, so a subpath's
  `types` in `package.json` is `./dist/<entry>/index.d.ts` while its JS
  stays flat (`./dist/<entry>.js`, vite names bundles by entry).
- **Tests mirror `src/`**: `__tests__/<folder>/<file>.test.ts` covers
  `src/<folder>/<file>.ts`; shared fixtures stay in `__tests__/helpers.ts`.

Source layout (`packages/ai-agent/src`) follows the same folder-per-concern
rule with its own one-way order:
`utils ← protocol ← policy ← session ← state ← store ← model-agent | agent-tool`;
`coding/`, `harness/`, `wire/`, `app/` and `testing/` sit on top of what they
need and nothing below imports them (`app/` type-imports `wire/` for
`AgentSessionClient` — types only, so `./app` still bundles neither). The core
(`.`) is domain-neutral — coding concepts (cwd, diffs, terminals, plans) live
only in `./coding`. `app/` is the only entry that touches
`@sigx/reactivity` / `@sigx/runtime-core`. Tests mirror `src/` the same way;
`__tests__/package/` holds package-level checks.

A provider package (`packages/ai-<vendor>/src`) is small enough for one file
per concern, no folders: `options.ts` (the `<Vendor>ProviderOptions`
interface), `request.ts` (our `ModelRequest` → SDK params), `stream.ts` (SDK
events → `ModelEvent`), `provider.ts` (the `<vendor>()` factory and default
model id), and a re-export-only `index.ts`. Layering:
`options ← request ← stream ← provider ← index`. Its recorded-fixture test
exercises the provider end to end and stays one file,
`__tests__/<vendor>.test.ts`.

## Parallel work with git worktrees

To work two things at once — each with its own checkout and its own agent
session — use a worktree instead of switching branches in place:

```sh
pnpm wt new <name> [--from <branch>]   # worktree at <repo>/branches/<name>: own branch + deps installed
pnpm wt list                           # show all worktrees
pnpm wt rm <name> [--force]            # remove a worktree
```

Layout convention (all sigx repos): the primary checkout lives at `<repo>/main`
and every worktree at `<repo>/branches/<name>`. `pnpm wt new` creates the
checkout there on a new branch `<name>` and runs `pnpm install` (pnpm hardlinks
from the global store — fast). Launch a **separate agent session from the
worktree directory**; sessions stay independent per directory. Names: letters,
digits, `.`, `_`, `-` only.

## Documentation

Docs are part of the change, not a follow-up — in-repo docs ship in the same
PR, and the docs-site update is queued (as a docs-repo issue) before merge. Two
surfaces, two rules:

**In-repo docs — update in *this* PR when you touch the matching thing:**

| When you… | Update… |
|---|---|
| add / rename / remove a package | `AGENTS.md` "Packages" and the README package table — plus, **whichever of these the repo has**: `CONTRIBUTING.md` layout, the issue-template package dropdowns, `.size-limit.json`, and the `tsconfig` / `vitest` path aliases |
| change a build / test / lint script | `AGENTS.md` "Build, Test, Lint", `CONTRIBUTING.md` "Common tasks", `package.json` |
| change or add public API / behaviour | the package's own `README.md` and `CHANGELOG.md` under `[Unreleased]` |
| change the workflow / process itself | `AGENTS.md` here — and, since it is the shared standard, upstream the same change to [`signalxjs/repo-template`](https://github.com/signalxjs/repo-template) |

**The docs *site* is separate — don't edit it from here.** User-facing changes
(new or changed public API, features, packages) must end up documented on the
docs site [`signalxjs/signalxjs.github.io`](https://github.com/signalxjs/signalxjs.github.io),
but that work belongs to the **docs agent**, which works through the docs repo's
issue queue. Don't open docs-site PRs from source repos — your job is to feed
the queue, in two moments:

- **Before merging a PR with user-facing changes, file an issue on the docs
  repo** describing what changed and what the docs need to cover, and link it
  from the PR:
  ```sh
  gh issue create --repo signalxjs/signalxjs.github.io \
    --title "ai: <what changed>" \
    --body "Source: signalxjs/ai#<pr>. <What needs documenting, and where on the site.> Not yet released."
  ```
  A user-facing PR isn't mergeable until its docs issue exists (see step 6 of
  the workflow).
- **When you cut a release** (push a `vX.Y.Z` tag), comment the release tag on
  every open docs issue covering a change shipped in that release:
  ```sh
  gh issue comment <n> --repo signalxjs/signalxjs.github.io \
    --body "Released in ai vX.Y.Z."
  ```
  (Mention the published package version(s) too if they differ from the tag.)
  A docs issue without a release comment means *merged but not released — don't
  document yet*; the release comment is the docs agent's signal that the change
  is live and ready to document.

## Conventions & working principles

- **Plan first for non-trivial work.** Both Claude Code and Copilot CLI have a built-in plan mode; use it and let the CLI manage the plan file.
- **Verify before declaring done.** Run typecheck/tests for code changes; show evidence the change works.
- **Test-first bug fixes.** Reproduce the bug with a *failing* unit test first (red), then make the fix so the test goes green — the failing test proves both that the bug exists and that the fix actually addresses it, and it stays behind as a regression test. Never fix a bug without a test that would have caught it. While you're in the area, if you find behaviour that should be covered but isn't, add the missing tests in the same PR.
- **Minimal, surgical edits.** Don't refactor unrelated code. Don't add backward-compat shims for things that never shipped.
- **Cross-platform paths**: Contributors and CI can run on Windows, macOS or Linux (check this repo's CI matrix for what it actually covers) — use the path separator and shell syntax of the environment you're in, and prefer Node scripts over shell one-liners for anything committed to the repo.
- **Git hygiene**: Stage specific files (`git add <path>`), never `git add -A` / `git add .`. Run `pnpm typecheck` before any commit touching `.ts`. Do **not** add co-author trailers to commits (e.g. `Co-Authored-By: Claude …` / `Co-authored-by: Copilot …`).

## Adopting this setup in another sigx repo

This file, `scripts/worktree.mjs`, and `CLAUDE.md` are the portable sigx
standard, maintained in [`signalxjs/repo-template`](https://github.com/signalxjs/repo-template).
To adopt it in another repo:

1. Check the repo out using the standard layout: primary checkout at
   `<repo>/main`, worktrees under `<repo>/branches/`.
2. Copy `scripts/worktree.mjs` and `CLAUDE.md` verbatim; copy this `AGENTS.md` as a template.
3. Add `"wt": "node scripts/worktree.mjs"` to the repo's `package.json` scripts.
4. Adapt the repo-specific sections of `AGENTS.md`: the intro (what the repo is),
   "Build, Test, Lint", and "Packages". Replace every `ai` with the repo name.
5. Keep the workflow, worktree, and conventions sections as-is — they are the
   shared standard.
6. Lock down `main`: `node scripts/apply-branch-protection.mjs signalxjs/ai`.
