/**
 * The playground's endpoints — five of them, and nothing else.
 *
 * This module is server-only: the agents, the provider SDKs, the keys, the
 * tool implementations and the policy live behind it (`agents.server.ts`,
 * `registry.server.ts`) and never ship. The client build swaps it for typed
 * stubs, which is all the browser needs.
 *
 * **`sessionId` rides the transport envelope, never the wire command.** The
 * wire protocol deliberately has no create/list/destroy verb — topology is an
 * app's business — and `SessionTransport` is just `{ send, events }`, so
 * routing by id outside the envelope is exactly the seam it leaves open. A
 * real app routes on `rq.principal` in the same place.
 *
 * There is no close endpoint on purpose: the wire's own `close` command
 * already reaches `session.close()`, which fans a `state: 'closed'` out to
 * every connected tab and lets the registry reap the session. One path, and
 * it also covers the ones an endpoint could not — a harness that dies on its
 * own, an adapter that closes itself.
 */
import { serverFn, serverStream } from '@sigx/server';
import { isWireCommand, WIRE_PROTOCOL_VERSION, type Cursor, type WireCommand, type WireFrame, type WireReply } from '@sigx/ai-agent/wire';
import { z } from 'zod';
import { AGENTS, type AgentCatalog, type OpenResult, type SessionInfo } from './catalog.js';
import { catalog, list, open, served } from './registry.server.js';

const CursorInput = z.object({ epoch: z.number().int().nonnegative(), seq: z.number().int().nonnegative() });
const SessionInput = z.object({ sessionId: z.string().min(1) });
/** The wire envelope is validated by the library (`isWireCommand`); this only proves it is an object. */
const CommandInput = SessionInput.extend({ command: z.looseObject({}) });
const EventsInput = SessionInput.extend({ from: CursorInput.optional() });
/** `z.enum` rejects an unknown agent here, so the registry only ever sees one it can build. */
const OpenInput = z.object({ agent: z.enum(AGENTS), model: z.string().max(200).optional(), cwd: z.string().max(4096).optional() });

/** What the New-session form offers: the agents, their models, and why any of them last failed. */
export const agentCatalog = serverFn({
    input: z.object({}),
    // Deliberate: the demo has no sign-in. See vite.config.ts.
    allowAnonymous: true,
    handler: (): AgentCatalog => catalog()
});

/**
 * The live sessions. Deliberately PURE — it opens nothing. A second tab reads
 * it to find the sessions the first tab opened and joins them as an observer,
 * and the smoke test reads it to prove that importing this module opens no
 * session at all.
 */
export const agentSessions = serverFn({
    input: z.object({}),
    allowAnonymous: true,
    handler: (): SessionInfo[] => list()
});

/**
 * Open one. Answers `{ ok: false, reason }` rather than throwing, so a missing
 * CLI renders as an install hint next to the form. An explicit choice never
 * falls back to another agent — that would be a lie in a tool for comparing
 * them.
 */
export const agentOpenSession = serverFn({
    input: OpenInput,
    allowAnonymous: true,
    handler: (_rq, input): Promise<OpenResult> => open(input)
});

/**
 * Commands in. `handleCommand` is idempotent by `commandId`, so a retried POST
 * never prompts twice or runs a turn twice.
 */
export const agentCommand = serverFn({
    input: CommandInput,
    allowAnonymous: true,
    handler: async (_rq, input): Promise<WireReply> => {
        const command = input.command as unknown;
        if (!isWireCommand(command)) {
            return { v: WIRE_PROTOCOL_VERSION, kind: 'error', commandId: '', code: 'invalid', message: 'not a wire command' };
        }
        const target = served(input.sessionId);
        // A client holding a stale id gets a typed wire error it can branch on
        // (`connectSession` surfaces it as `remote: 'closed'`), not a throw.
        if (!target) {
            return { v: WIRE_PROTOCOL_VERSION, kind: 'error', commandId: command.commandId, code: 'closed', message: `no session "${input.sessionId}"` };
        }
        // A real app passes `rq.principal` as the second argument and gives
        // `serveSession` an `authorize` — that is where "who may cancel whose
        // turn" is decided.
        return target.handleCommand(command as WireCommand);
    }
});

/**
 * Frames out. The stream is the session: `from` is the client's cursor, so a
 * reconnect resumes exactly where it stopped and a fresh tab asking for
 * `(0, 0)` replays the whole conversation before it goes live.
 */
export const agentEvents = serverStream({
    input: EventsInput,
    allowAnonymous: true,
    handler: async function* (rq, input): AsyncGenerator<WireFrame> {
        const target = served(input.sessionId);
        // Throw rather than yield nothing: an empty stream makes
        // `connectSession` retry its way to "the event stream ended before a
        // hello frame", which tells an operator nothing about what went wrong.
        if (!target) throw new Error(`no session "${input.sessionId}"`);
        const from: Cursor | undefined = input.from;
        // A closed tab ends the subscription; the session keeps running.
        yield* target.events(from, { signal: rq.abortSignal });
    }
});
