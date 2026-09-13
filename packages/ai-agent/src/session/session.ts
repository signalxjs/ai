/**
 * `createSessionCore` — the part of `AgentSession` that is the same for every
 * adapter: the busy check, the open-request table `respond()` answers into,
 * `state` bookkeeping, cancel and close. An adapter wraps it and supplies the
 * per-turn `run`.
 */

import { AgentError, SessionBusyError } from '../protocol/index.js';
import type { AgentCapabilities, AgentEvent, Decision, PromptInput, PromptPart, SessionState, UnstampedEvent } from '../protocol/index.js';
import { toPromptParts } from '../protocol/index.js';
import { createGrants, resolveRequest } from '../policy/index.js';
import type { Policy, PolicyRequest, Resolved, SessionGrants } from '../policy/index.js';
import { abortError } from '../utils/abort.js';
import { generateId } from '../utils/id.js';
import type { AgentTurn, EventCursor, PromptOptions } from './agent.js';
import type { SessionLog } from './event-log.js';
import { createTurn, failedTurn, type ManagedTurn, type TurnDriver } from './turn.js';

export interface SessionCoreOptions {
    readonly id: string;
    readonly log: SessionLog;
    readonly grants?: SessionGrants;
    readonly policy?: Policy;
    /** Default `true`. */
    readonly interactive?: boolean;
    readonly requestTimeoutMs?: number;
    readonly signal?: AbortSignal;
    /** The agent's `steer` capability: a prompt during a turn is allowed. */
    readonly steer?: boolean;
    /** The agent's `promptParts` capability: a part beyond it fails the prompt before any event. Default: everything. */
    readonly promptParts?: AgentCapabilities['promptParts'];
    readonly now?: () => number;
}

/** The part kinds each `promptParts` level admits. */
const ADMITTED: Record<AgentCapabilities['promptParts'], ReadonlySet<PromptPart['type']>> = {
    text: new Set(['text']),
    'text+image': new Set(['text', 'image']),
    'text+image+file': new Set(['text', 'image', 'file', 'resource'])
};

/** Per-turn context handed to `run` alongside the driver. */
export interface TurnContext {
    readonly options: PromptOptions;
    /** `resolveRequest` wired to this session and turn. */
    resolve(request: PolicyRequest, extra?: { readonly requestId?: string }): Promise<Resolved>;
}

export interface SessionCore {
    readonly id: string;
    readonly log: SessionLog;
    readonly grants: SessionGrants;
    readonly signal: AbortSignal;
    readonly state: SessionState;
    readonly current: ManagedTurn | null;
    readonly closed: boolean;
    startTurn(input: PromptInput, options: PromptOptions | undefined, run: (driver: TurnDriver, ctx: TurnContext) => Promise<void>): AgentTurn;
    respond(requestId: string, decision: Decision): Promise<void>;
    cancel(): Promise<void>;
    subscribe(from?: EventCursor): AsyncIterable<AgentEvent>;
    /** Session-level events (`config`, session `usage`, `error`, `ext`). */
    emit(event: UnstampedEvent): AgentEvent;
    setState(value: SessionState): void;
    close(): Promise<void>;
}

export function createSessionCore(options: SessionCoreOptions): SessionCore {
    const { id, log } = options;
    const grants = options.grants ?? createGrants();
    const interactive = options.interactive ?? true;
    const controller = new AbortController();
    if (options.signal) {
        if (options.signal.aborted) controller.abort(options.signal.reason);
        else options.signal.addEventListener('abort', () => controller.abort(options.signal!.reason), { once: true });
    }
    const pending = new Map<string, { resolve: (d: Decision) => void; reject: (e: unknown) => void }>();
    let current: ManagedTurn | null = null;
    let state: SessionState = 'idle';
    let closed = false;
    let openRequests = 0;

    const setState = (value: SessionState) => {
        if (state === value || closed) return;
        state = value;
        log.append({ type: 'state', value });
    };

    const core: SessionCore = {
        id,
        log,
        grants,
        signal: controller.signal,
        get state() {
            return state;
        },
        get current() {
            return current;
        },
        get closed() {
            return closed;
        },
        emit: (event) => log.append(event),
        setState,
        startTurn(input, promptOptions, run) {
            const turnId = promptOptions?.turnId ?? generateId('turn');
            if (closed) return failedTurn(turnId, new AgentError('protocol_error', `[sigx ai-agent] session "${id}" is closed`));
            if (current && !current.settled && !options.steer) return failedTurn(turnId, new SessionBusyError(id, current.id));
            const parts = toPromptParts(input);
            const refused = options.promptParts ? parts.find((p) => !ADMITTED[options.promptParts!].has(p.type)) : undefined;
            if (refused) return failedTurn(turnId, new AgentError('protocol_error', `[sigx ai-agent] session "${id}" accepts promptParts "${options.promptParts}" — a ${refused.type} part was refused`));
            const turn = createTurn({
                log,
                turnId,
                input: parts,
                signals: [controller.signal, promptOptions?.signal],
                run: (driver) => {
                    const ctx: TurnContext = {
                        options: promptOptions ?? {},
                        resolve: (request, extra) => {
                            openRequests++;
                            setState('awaiting');
                            return resolveRequest(request, {
                                sessionId: id,
                                turnId: driver.turnId,
                                interactive,
                                grants,
                                signal: driver.signal,
                                ...(options.policy ? { policy: options.policy } : {}),
                                ...(options.requestTimeoutMs !== undefined ? { timeoutMs: options.requestTimeoutMs } : {}),
                                ...(extra?.requestId !== undefined ? { requestId: extra.requestId } : {}),
                                ...(options.now ? { now: options.now } : {}),
                                newId: () => generateId('req'),
                                emit: (e) => {
                                    driver.emit(e);
                                },
                                awaitClient: (requestId, signal) =>
                                    new Promise<Decision>((resolve, reject) => {
                                        // Settle once, and drop the abort listener either way — a
                                        // session answers many requests over its life.
                                        const onAbort = () => entry.reject(abortError(signal));
                                        const done = () => {
                                            pending.delete(requestId);
                                            signal.removeEventListener('abort', onAbort);
                                        };
                                        const entry = {
                                            resolve: (d: Decision) => {
                                                done();
                                                resolve(d);
                                            },
                                            reject: (e: unknown) => {
                                                done();
                                                reject(e);
                                            }
                                        };
                                        pending.set(requestId, entry);
                                        signal.addEventListener('abort', onAbort, { once: true });
                                    })
                            }).finally(() => {
                                openRequests--;
                                if (openRequests === 0 && !driver.ended) setState('running');
                            });
                        }
                    };
                    return run(driver, ctx);
                },
                onSettle: () => {
                    if (current === turn) current = null;
                    if (!closed) setState('idle');
                }
            });
            current = turn;
            setState('running');
            return turn;
        },
        async respond(requestId, decision) {
            // A late answer — the policy, a timeout or a cancel got there first — is not an error.
            pending.get(requestId)?.resolve(decision);
        },
        async cancel() {
            current?.cancel();
        },
        subscribe: (from) => log.subscribe(from),
        async close() {
            if (closed) return;
            controller.abort();
            const turn = current;
            if (turn && !turn.settled) await turn.result;
            for (const [, p] of pending) p.resolve({ type: 'cancel' });
            pending.clear();
            state = 'closed';
            log.append({ type: 'state', value: 'closed' });
            closed = true;
            log.close();
        }
    };
    return core;
}
