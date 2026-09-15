/**
 * The browser's half of the playground: one `connectSession` client per live
 * session, and the reactive rows the sidebar reads.
 *
 * The clients are objects, not state — they live in a plain `Map` outside the
 * reactive proxy. What is reactive is the ROWS: id, agent, model, state, mode.
 * Same discipline the single-session version had, N times.
 */
import { signal } from 'sigx';
import { connectSession, type AgentSessionClient, type Cursor, type SessionTransport, type WireCommand, type WireFrame, type WireReply } from '@sigx/ai-agent/wire';
import { agentCatalog, agentCommand, agentEvents, agentOpenSession, agentSessions } from './agent.server';
import type { AgentCatalog, OpenRequest, OpenResult, SessionInfo } from './catalog';

/**
 * The `selected` value while a session is being created. Not a session id —
 * the server has not given one yet — but a pane all the same: the one that
 * says "Creating session…" so a click on New session shows something at
 * once, instead of the previous conversation for however long the harness
 * takes to start (Copilot's ACP server: ~13 s). A symbol, because session
 * ids are the adapters' strings and no string is safe from colliding.
 */
export const OPENING: unique symbol = Symbol('opening');

export interface PlaygroundState {
    rows: SessionInfo[];
    catalog: AgentCatalog | undefined;
    /** The session whose pane is showing — or `OPENING` while one is being created. */
    selected: string | typeof OPENING;
    /** The request in flight, while a session is being created. One at a time: the form is disabled meanwhile. */
    opening: OpenRequest | undefined;
    /** Show every pane side by side instead of one. */
    compare: boolean;
    error: string;
    ready: boolean;
}

export interface Playground {
    readonly state: PlaygroundState;
    client(sessionId: string): AgentSessionClient | undefined;
    refresh(): Promise<void>;
    open(request: OpenRequest): Promise<void>;
    close(sessionId: string): Promise<void>;
    select(sessionId: string | typeof OPENING): void;
    disconnectAll(): void;
}

/**
 * The server, as the playground calls it. The default is the real endpoints;
 * a test passes scripted ones and mounts the shell against them, with no
 * module mocking.
 */
export interface PlaygroundApi {
    catalog(): Promise<AgentCatalog>;
    sessions(): Promise<readonly SessionInfo[]>;
    open(request: OpenRequest): Promise<OpenResult>;
    command(sessionId: string, command: WireCommand): Promise<WireReply>;
    events(sessionId: string, from?: Cursor): AsyncIterable<WireFrame>;
}

export const serverApi: PlaygroundApi = {
    catalog: () => agentCatalog({}),
    sessions: () => agentSessions({}),
    open: (request) => agentOpenSession(request),
    command: (sessionId, command) => agentCommand({ sessionId, command }),
    events: (sessionId, from) => agentEvents(from ? { sessionId, from } : { sessionId })
};

export function createPlayground(api: PlaygroundApi = serverApi): Playground {
    const state = signal<PlaygroundState>({ rows: [], catalog: undefined, selected: '', opening: undefined, compare: false, error: '', ready: false });
    const clients = new Map<string, AgentSessionClient>();
    /** `disconnectAll()` ran: an open that lands after it must not leave a connection nobody owns. */
    let disconnected = false;

    /**
     * One transport per session. `sessionId` travels beside the wire command,
     * never inside it — the envelope is the library's, the routing is ours.
     */
    const transportFor = (sessionId: string): SessionTransport => ({
        send: (command) => api.command(sessionId, command),
        events: (from) => api.events(sessionId, from)
    });

    const patch = (sessionId: string, change: Partial<SessionInfo>) => {
        state.rows = state.rows.map((row) => (row.sessionId === sessionId ? { ...row, ...change } : row));
    };

    /** The pending pane came to nothing: back to where the operator was, unless they moved on (or that session is gone). */
    const unselectOpening = (previous: string | typeof OPENING) => {
        if (state.selected === OPENING) state.selected = state.rows.some((row) => row.sessionId === previous) ? previous : (state.rows[0]?.sessionId ?? '');
    };

    const forget = (sessionId: string) => {
        clients.delete(sessionId);
        state.rows = state.rows.filter((row) => row.sessionId !== sessionId);
        if (state.selected === sessionId) state.selected = state.rows[0]?.sessionId ?? '';
    };

    /**
     * Follow a session for the sidebar. This costs no extra request: the
     * client republishes what its own stream already carries, so `subscribe()`
     * reads a local buffer. When it ends, the session is gone.
     */
    function watch(sessionId: string, client: AgentSessionClient): void {
        void (async () => {
            try {
                for await (const event of client.subscribe()) {
                    if (event.type === 'state') patch(sessionId, { state: event.value });
                    else if (event.type === 'config') patch(sessionId, { config: event.options });
                }
            } catch {
                // A session that failed is still a session that ended.
            } finally {
                forget(sessionId);
            }
        })();
    }

    async function attach(info: SessionInfo): Promise<void> {
        if (clients.has(info.sessionId)) return;
        const client = await connectSession(transportFor(info.sessionId), {
            from: { epoch: 0, seq: 0 },
            // A reload of a long session replays everything into this buffer
            // BEFORE the pane mounts, and `useAgentSession` then subscribes
            // from `{0,0}` — with the default 2000 the start would already be
            // evicted and that subscribe throws, leaving an empty transcript.
            bufferSize: 50_000
        });
        // The page went away while the harness was starting (a slow one takes
        // long enough): the session stays on the server, this connection does not.
        if (disconnected) {
            client.disconnect();
            return;
        }
        clients.set(info.sessionId, client);
        state.rows = [...state.rows, info];
        if (!state.selected) state.selected = info.sessionId;
        watch(info.sessionId, client);
    }

    return {
        state,
        client: (sessionId) => clients.get(sessionId),

        /**
         * Read the server's list and join anything not already joined — which
         * is how a second tab finds the sessions the first one opened and
         * becomes a late observer of every one of them.
         */
        async refresh() {
            try {
                const [catalog, sessions] = await Promise.all([api.catalog(), api.sessions()]);
                state.catalog = catalog;
                // One session that will not attach must not stop the others.
                for (const info of sessions) {
                    await attach(info).catch((e: unknown) => {
                        state.error = `Could not follow session ${info.sessionId}: ${e instanceof Error ? e.message : String(e)}`;
                        console.error('[agent] attach failed', e);
                    });
                }
            } finally {
                state.ready = true;
            }
        },

        /**
         * Show the session before it exists: the pending pane is selected the
         * moment the button is clicked, and the row it becomes takes its place.
         * A second click while one is in flight is ignored — the form is
         * disabled, but a double-click beats a re-render.
         *
         * And never let it fail silently. Opening crosses two network calls and
         * can spawn a process; a rejection anywhere used to vanish into the
         * `void` at the call site, and the page just sat there.
         */
        async open(request) {
            if (state.opening) return;
            state.error = '';
            const previous = state.selected;
            state.opening = request;
            state.selected = OPENING;
            try {
                const result = await api.open(request);
                if (!result.ok) {
                    state.error = result.reason;
                    unselectOpening(previous);
                    // The catalogue learned why; re-read it so the form can
                    // grey the agent out and show the install hint.
                    state.catalog = await api.catalog().catch(() => state.catalog);
                    return;
                }
                await attach(result.session);
                // Unless the operator moved on to another session meanwhile.
                if (state.selected === OPENING) state.selected = result.session.sessionId;
            } catch (e) {
                state.error = `Could not open a ${request.agent} session: ${e instanceof Error ? e.message : String(e)}`;
                console.error('[agent] open failed', e);
                unselectOpening(previous);
            } finally {
                state.opening = undefined;
            }
        },

        /**
         * Closing is the wire's own `close` command — no endpoint of ours. The
         * server reaps the session, and every other tab watching it sees
         * `state: 'closed'` and drops its row too.
         */
        async close(sessionId) {
            const client = clients.get(sessionId);
            if (!client) return;
            // Drop it locally whatever the server says: a session we cannot
            // reach is not one the sidebar should keep offering.
            await client.close().catch((e: unknown) => console.warn('[agent] close failed', e));
            forget(sessionId);
        },

        select(sessionId) {
            state.selected = sessionId;
        },

        disconnectAll() {
            disconnected = true;
            for (const client of clients.values()) client.disconnect();
            clients.clear();
        }
    };
}
