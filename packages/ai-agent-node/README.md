# @sigx/ai-agent-node

> **Experimental** — 0.x, part of the `@sigx/ai-agent` family (tracking issue
> [signalxjs/ai#35](https://github.com/signalxjs/ai/issues/35)).

The Node building blocks for [`@sigx/ai-agent`](https://www.npmjs.com/package/@sigx/ai-agent)
adapters, kept out of that package so it stays edge-safe. Everything here that
touches processes, paths or stdio is tested on Windows, macOS and Linux.

```ts
import { resolveExecutable, spawnAgentProcess } from '@sigx/ai-agent-node';
import { createJsonRpcPeer } from '@sigx/ai-agent/harness';

const exe = await resolveExecutable('gemini');                       // PATH / Path, PATHEXT, npm .cmd shims
// Keep `exe.env` (a pnpm shim's NODE_PATH) and add what the harness needs.
const proc = spawnAgentProcess({ ...exe, args: [...exe.args, '--experimental-acp'], cwd, env: { ...exe.env, GEMINI_API_KEY: key } });
const peer = createJsonRpcPeer({ readable: proc.readable, writable: proc.writable });
// …
await proc.kill(); // the whole tree, on every OS
```

## What it does

- **`resolveExecutable(name, { env?, cwd?, platform? })`** — `PATH` lookup with
  a case-insensitive key on Windows (`Path`), `PATHEXT` extensions, `.js`/`.mjs`
  run under `process.execPath`. An npm or pnpm **`.cmd` shim** is read (≤ 8 KiB)
  and its JS entry is run with `process.execPath` (`kind: 'node-script'`,
  pnpm's `NODE_PATH` carried along in `env`) — Node refuses to spawn shims
  without a shell (CVE-2024-27980), and a shell is exactly what we avoid. Only
  a shim we cannot parse falls back to `kind: 'cmd-shim'`.
- **`spawnAgentProcess({ command, args, cwd, env, inheritEnv?, kind? })`** —
  never `shell: true`. A `cmd-shim` runs through `cmd.exe /d /s /c` with one
  strictly quoted command string; an argument containing `%` is refused
  (`UnsafeArgumentError`) because `%VAR%` expansion cannot be escaped there.
  `readable` / `writable` are Web Streams with real backpressure (they plug
  into `createJsonRpcPeer`); `stderrTail()` keeps the last 64 KiB for the
  error a dead process turns into (`ProcessExitedError`); `exited` resolves
  with `{ code, signal, stderrTail }`.
- **`kill({ graceMs })`** — POSIX: `SIGTERM` to the process group (children
  are spawned `detached`), `SIGKILL` after the grace period; Windows:
  `taskkill /pid <pid> /T /F` through `execFile`. Idempotent, resolves when
  the tree is gone. Children are also killed when the parent exits
  (`registerChild`, installed once); `installSignalForwarding()` is opt-in.
- **`buildChildEnv({ base?, allow?, extra?, inheritEnv? })`** — the child
  environment is an **allowlist**, not an inheritance: `PATH`, `PATHEXT`,
  home and config directories (`HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`,
  `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `XDG_*`), temp (`TMP`, `TEMP`,
  `TMPDIR`), system (`SystemRoot`, `windir`, `ComSpec`, `SystemDrive`), user
  and shell (`USERNAME`, `USER`, `LOGNAME`, `SHELL`), locale and terminal
  (`LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`, `COLORTERM`), proxies
  (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and lower-case), certificates
  (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`) — plus whatever the caller adds
  (`env: { ANTHROPIC_API_KEY }`). `NODE_OPTIONS` never passes through. Keys
  match case-insensitively on Windows.
- **`listenMcp(handler, { host = '127.0.0.1', port = 0, path = '/mcp', token? })`**
  — serves a `(Request) => Promise<Response>` handler (the MCP tool handler
  from `@sigx/ai-agent/harness`) on `node:http`, loopback only, behind a
  bearer token compared in constant time. Returns `{ url, token, headers,
  close }` to hand to a harness as an HTTP MCP server.

## Install

```bash
npm install @sigx/ai @sigx/ai-agent @sigx/ai-agent-node
```

Node `^20.19.0 || >=22.12.0`. Adapters that spawn a harness depend on this
package; apps rarely import it directly.

## Documentation

**<https://sigx.dev/ai/>**

## License

MIT © Andreas Ekdahl
