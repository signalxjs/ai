/**
 * `useAgentSession` — a reactive transcript driven by an agent session.
 *
 * The transcript is ONE reactive proxy (`signal(createTranscript(id))`) and
 * `reduceAgentEvent` folds into it IN PLACE, so a `part-delta` is
 * `part.text += delta` — a single property write, observed by the one text
 * node that reads it. The message list, the other parts and the composer
 * never re-render. That is the whole reason the reducer mutates.
 *
 * The source is an `AgentSession` — in-process, or an `AgentSessionClient`
 * from `connectSession`, which is one. Nothing here knows which: the session
 * contract is the seam.
 *
 * SSR-safe: the subscription starts on MOUNT, so a server render folds
 * nothing and opens no queue. Unmount unsubscribes — and does NOT close the
 * session, which usually outlives the component (another tab, another
 * device, the server). After unmount nothing here touches the view again:
 * an action that settles late (a turn still running when the user navigated
 * away) writes no state and fires no callback.
 *
 * Subscribing from `{ epoch: 0, seq: 0 }` by default makes a late joiner
 * replay the session from its start: a second tab reaches the same transcript
 * as the first, which is what `(epoch, seq)` is for.
 */

import { signal, untrack } from '@sigx/reactivity';
import { getCurrentInstance } from '@sigx/runtime-core';
import type { Usage } from '@sigx/ai';
import type { AgentCapabilities, AgentEvent, ConfigOption, Decision, PromptInput, SessionState } from '../protocol/index.js';
import { AgentError } from '../protocol/index.js';
import type { AgentSession, EventCursor, PromptOptions, TurnResult } from '../session/index.js';
import type { AgentMessage, AgentNode, AgentState, AgentTranscript, OpenRequest, ReducerExtension, TranscriptError, TurnState } from '../state/index.js';
import { agentTree, createReducer, createTranscript } from '../state/index.js';
import type { AgentSessionClient } from '../wire/index.js';

/**
 * Where the events come from. An `AgentSessionClient` already satisfies
 * `AgentSession`; naming both says what the composable is for — the same view
 * over a local session and a remote one.
 */
export type AgentSessionSource = AgentSession | AgentSessionClient;

export interface UseAgentSessionOptions {
    /** Reducer plugins for `ext` namespaces — e.g. `[codingExtension()]`. */
    readonly extensions?: readonly ReducerExtension[];
    /**
     * Where to start folding. Default `{ epoch: 0, seq: 0 }` — everything the
     * session can still replay, so a late joiner catches up. `'live'` starts
     * at the next event and leaves the transcript empty.
     */
    readonly from?: EventCursor | 'live';
    /** Every event, after it has been folded. */
    readonly onEvent?: (event: AgentEvent) => void;
    /** One completed turn, as `prompt()` resolves it. Not called after unmount. */
    readonly onTurnEnd?: (result: TurnResult) => void;
    /** A failed action or a broken subscription. The same failure lands in `error`. Not called after unmount. */
    readonly onError?: (error: Error) => void;
}

export interface AgentSessionView {
    readonly sessionId: string;
    /** The folded session — reactive; read it in a view. */
    readonly transcript: AgentTranscript;
    /** `transcript.messages`, for the common case. */
    readonly messages: readonly AgentMessage[];
    readonly state: SessionState;
    /** The running or most recent turn. */
    readonly turn: TurnState | undefined;
    /** Unresolved requests, oldest first — answer one with `respond()`. */
    readonly requests: readonly OpenRequest[];
    readonly usage: Usage | undefined;
    readonly costUsd: number | undefined;
    readonly config: readonly ConfigOption[];
    /** Sub-agents in start order — `transcript.agents` as a list. */
    readonly agents: readonly AgentState[];
    /** The same as a tree (`agentTree(transcript)`): root agents with their children. */
    readonly agentTree: readonly AgentNode[];
    readonly error: TranscriptError | undefined;
    /** Following the session: false before mount (and during SSR), false again after unmount. */
    readonly live: boolean;
    /**
     * The transport is up. A `connectSession` client reports its `status`;
     * a local session is connected whenever it is followed (`live`). A lost
     * connection lands in `error` (recoverable) — `reconnect()` picks it up.
     */
    readonly connected: boolean;
    /** What the agent delivers, when the source knows (a `connectSession` client). */
    readonly capabilities: AgentCapabilities | undefined;
    /**
     * Run a turn. Resolves with its result — or `undefined` when it could not
     * run (a busy session, a broken transport), which lands in `error` and
     * `onError` instead of rejecting, so a click handler needs no `catch`.
     *
     * While a turn runs (`state` is `running` or `awaiting`) and the agent has
     * the `steer` capability, the input steers that turn instead: it lands as
     * a `user-message` inside it, `turn` stays the same turn, and the promise
     * resolves with that turn's result. `onTurnEnd` fires once per turn,
     * however many prompts steered it.
     */
    prompt(input: PromptInput, options?: PromptOptions): Promise<TurnResult | undefined>;
    /** Answer an open `request` — one raised by a sub-agent too. A late answer resolves without effect. */
    respond(requestId: string, decision: Decision): Promise<void>;
    /** Cancel the running turn. */
    cancel(): Promise<void>;
    /** Cancel one sub-agent while the turn goes on (`subagents: 'control'`); fails (into `error`) otherwise. */
    cancelAgent(agentId: string): Promise<void>;
    /** Change a `config` option; fails (into `error`) when the agent has no `config` capability. */
    configure(patch: Readonly<Record<string, string>>): Promise<void>;
    /** After a lost connection: follow the remote session again from where it stopped. A no-op for a local session or while connected. */
    reconnect(): void;
}

export function useAgentSession(source: AgentSessionSource, options: UseAgentSessionOptions = {}): AgentSessionView {
    const instance = getCurrentInstance();
    if (!instance) {
        throw new Error('[sigx ai-agent] useAgentSession() must be called inside component setup.');
    }

    const transcript = signal(createTranscript(source.id) as AgentTranscript);
    const client = source as Partial<AgentSessionClient>;
    // A client reports its transport; a local session is "connected" while followed.
    const hasStatus = typeof client.onStatusChange === 'function';
    const status = signal({ live: false, connected: hasStatus && client.status === 'connected' });
    const reduce = createReducer(options.extensions ? { extensions: options.extensions } : {});

    let iterator: AsyncIterator<AgentEvent> | null = null;
    let stopped = false;
    let unwatch: (() => void) | undefined;
    // The turn last reported through `onTurnEnd`: a steer resolves with the
    // running turn's result, and that turn ends once. One id is enough — a
    // session runs one turn at a time, so a later prompt either steers this
    // one or starts the next.
    let reported: string | undefined;

    /** A failure becomes the transcript's error, in the shape an `error` event has. */
    function fail(e: unknown): void {
        // An action can settle long after the view is gone (navigation away
        // mid-turn). Unmount means NO further view-side effect: not a write,
        // not a callback. Every action funnels its failure through here, so
        // the guard lives in one place.
        if (stopped) return;
        const error = e instanceof Error ? e : new Error(String(e));
        untrack(() => {
            transcript.error = {
                code: error instanceof AgentError ? error.code : 'protocol_error',
                message: error.message,
                recoverable: error instanceof AgentError ? error.recoverable : false
            };
        });
        options.onError?.(error);
    }

    function follow(): void {
        const from = options.from === 'live' ? undefined : (options.from ?? { epoch: 0, seq: 0 });
        let events: AsyncIterable<AgentEvent>;
        try {
            events = source.subscribe(from);
        } catch (e) {
            fail(e);
            return;
        }
        const it = events[Symbol.asyncIterator]();
        iterator = it;
        untrack(() => {
            status.live = true;
        });
        void (async () => {
            try {
                for (;;) {
                    const next = await it.next();
                    // Unmounted mid-await: never write state again.
                    if (stopped) return;
                    if (next.done) break;
                    const event = next.value;
                    // One in-place fold per event — the fine-grained write the
                    // whole design exists for. `untrack` so a caller that reads
                    // the view inside an effect never records these as reads.
                    untrack(() => {
                        reduce(transcript, event);
                    });
                    options.onEvent?.(event);
                }
                // The subscription ended. A session that closed (its `state: closed`
                // folded first) or a client the app disconnected is a clean end;
                // anything else stopped following a session that is still open.
                if (transcript.state !== 'closed' && client.status !== 'closed') {
                    fail(new AgentError('protocol_error', `[sigx ai-agent] the subscription to session "${source.id}" ended before the session closed`, true));
                }
            } catch (e) {
                fail(e);
            } finally {
                if (!stopped) {
                    untrack(() => {
                        status.live = false;
                    });
                }
            }
        })();
    }

    function unfollow(): void {
        stopped = true;
        const it = iterator;
        iterator = null;
        unwatch?.();
        unwatch = undefined;
        untrack(() => {
            status.live = false;
            status.connected = false;
        });
        // Ends our queue (and only ours). The session stays open.
        if (it) void it.return?.().catch(() => {});
    }

    /** A client's transport status: `connected` follows it; `lost` is an error the user can act on. */
    function watch(): void {
        if (!hasStatus) return;
        unwatch = client.onStatusChange!((value) => {
            if (stopped) return;
            untrack(() => {
                status.connected = value === 'connected';
            });
            if (value === 'lost') fail(new AgentError('protocol_error', `[sigx ai-agent] the connection to session "${source.id}" was lost`, true));
        });
        untrack(() => {
            status.connected = client.status === 'connected';
        });
    }

    // Mount, not setup: a server render must not open a subscription it can
    // never close, and has nothing to stream into the markup anyway.
    instance.onMounted(() => {
        if (stopped) return;
        watch();
        follow();
    });
    instance.onUnmounted(unfollow);

    return {
        sessionId: source.id,
        get transcript() {
            return transcript;
        },
        get messages() {
            return transcript.messages;
        },
        get state() {
            return transcript.state;
        },
        get turn() {
            return transcript.turn;
        },
        get requests() {
            return Object.values(transcript.requests).sort((a, b) => a.seq - b.seq);
        },
        get usage() {
            return transcript.usage;
        },
        get costUsd() {
            return transcript.costUsd;
        },
        get config() {
            return transcript.config;
        },
        get agents() {
            return Object.values(transcript.agents).sort((a, b) => a.seq - b.seq);
        },
        get agentTree() {
            return agentTree(transcript);
        },
        get error() {
            return transcript.error;
        },
        get live() {
            return status.live;
        },
        get connected() {
            return hasStatus ? status.connected : status.live;
        },
        get capabilities() {
            return client.capabilities;
        },
        async prompt(input, promptOptions) {
            try {
                // The subscription is what renders the turn; `result` is only
                // its outcome, so nothing here iterates the turn twice.
                const turn = source.prompt(input, promptOptions);
                const result = await turn.result;
                // The caller still gets what it awaited — but a view that is
                // gone gets no callback (see `fail`), and a turn that several
                // prompts steered ends once. Read the id AFTER the result: a
                // remote handle learns which turn it joined from the ack.
                if (!stopped && reported !== turn.id) {
                    reported = turn.id;
                    options.onTurnEnd?.(result);
                }
                return result;
            } catch (e) {
                fail(e);
                return undefined;
            }
        },
        async respond(requestId, decision) {
            try {
                await source.respond(requestId, decision);
            } catch (e) {
                fail(e);
            }
        },
        async cancel() {
            try {
                await source.cancel();
            } catch (e) {
                fail(e);
            }
        },
        async cancelAgent(agentId) {
            try {
                await source.cancel({ agentId });
            } catch (e) {
                fail(e);
            }
        },
        async configure(patch) {
            try {
                if (!source.configure) throw new AgentError('protocol_error', `[sigx ai-agent] session "${source.id}" does not support configure()`);
                await source.configure(patch);
            } catch (e) {
                fail(e);
            }
        },
        reconnect() {
            if (stopped) return;
            client.reconnect?.();
        }
    };
}
