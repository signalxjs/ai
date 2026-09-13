/**
 * `createSessionCore` — the part of `AgentSession` that is the same for every
 * adapter: the busy check, the open-request table `respond()` answers into,
 * `state` bookkeeping, steering, cancel and close. An adapter wraps it and
 * supplies the per-turn `run`.
 *
 * Steering: with `steer`, a prompt while a turn runs does not start a second
 * turn — the parts go to the handler the running turn registered with
 * `ctx.onSteer` (queued until it does), and the caller gets a handle to the
 * RUNNING turn. The adapter's handler injects the input natively and emits the
 * `user-message`, so the transcript stays the adapter's to shape.
 *
 * Sub-agents: `attach()` registers a downstream session (a delegate a tool
 * opened) so `respond()` and an addressed `cancel()` reach it; a downstream
 * that attaches its own children forwards the same way, so depth falls out.
 */

import { AgentError, SessionBusyError } from '../protocol/index.js';
import type { AgentCapabilities, AgentEvent, Decision, PromptInput, PromptPart, SessionState, UnstampedEvent } from '../protocol/index.js';
import { toPromptParts } from '../protocol/index.js';
import { createGrants, resolveRequest } from '../policy/index.js';
import type { Policy, PolicyRequest, Resolved, SessionGrants } from '../policy/index.js';
import { abortError } from '../utils/abort.js';
import { generateId } from '../utils/id.js';
import type { AgentTurn, CancelTarget, EventCursor, PromptOptions } from './agent.js';
import type { SessionLog } from './event-log.js';
import { createTurn, failedTurn, filterTurn, type ManagedTurn, type TurnDriver } from './turn.js';

export interface SessionCoreOptions {
    readonly id: string;
    readonly log: SessionLog;
    readonly grants?: SessionGrants;
    readonly policy?: Policy;
    /** Default `true`. */
    readonly interactive?: boolean;
    readonly requestTimeoutMs?: number;
    readonly signal?: AbortSignal;
    /** The agent's `steer` capability: a prompt during a turn steers it instead of rejecting. */
    readonly steer?: boolean;
    /** The agent's `subagents` capability: `'control'` lets `cancel({ agentId })` reach attachments. Default `'none'`. */
    readonly subagents?: AgentCapabilities['subagents'];
    /** The agent's `promptParts` capability: a part beyond it fails the prompt before any event. Default: everything. */
    readonly promptParts?: AgentCapabilities['promptParts'];
    readonly now?: () => number;
}

/** A downstream session `respond()` and an addressed `cancel()` are forwarded to. */
export interface AttachedSession {
    respond?(requestId: string, decision: Decision): Promise<void>;
    cancel?(target: CancelTarget): Promise<void>;
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
    /** `resolveRequest` wired to this session and turn; `parentCallId` stamps a request raised inside a sub-agent. */
    resolve(request: PolicyRequest, extra?: { readonly requestId?: string; readonly parentCallId?: string }): Promise<Resolved>;
    /** Receive steering input for this turn; input that arrived before registration is delivered at once. */
    onSteer(handler: (parts: readonly PromptPart[]) => void): void;
}

export interface SessionCore {
    readonly id: string;
    readonly log: SessionLog;
    readonly grants: SessionGrants;
    readonly signal: AbortSignal;
    readonly state: SessionState;
    readonly current: ManagedTurn | null;
    readonly closed: boolean;
    /** Start a turn — or, with `steer`, join the running one (see `steer`). */
    startTurn(input: PromptInput, options: PromptOptions | undefined, run: (driver: TurnDriver, ctx: TurnContext) => Promise<void>): AgentTurn;
    /** Inject into the running turn: a handle with the running turn's `id` and `result` that iterates from the steer on. */
    steer(input: PromptInput, options?: PromptOptions): AgentTurn;
    /** Forward `respond()` and addressed `cancel()` to a downstream session; returns detach. */
    attach(downstream: AttachedSession): () => void;
    respond(requestId: string, decision: Decision): Promise<void>;
    cancel(target?: CancelTarget): Promise<void>;
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
    const attached = new Set<AttachedSession>();
    let current: ManagedTurn | null = null;
    let state: SessionState = 'idle';
    let closed = false;
    let openRequests = 0;
    // Steering state of the running turn: the handler its run registered, and
    // the input that arrived before it did.
    let steerHandler: ((parts: readonly PromptPart[]) => void) | null = null;
    let queuedSteers: (readonly PromptPart[])[] = [];

    const setState = (value: SessionState) => {
        if (state === value || closed) return;
        state = value;
        log.append({ type: 'state', value });
    };

    /** The first part `promptParts` does not admit, if any. */
    const refusedPart = (parts: readonly PromptPart[]): PromptPart | undefined => (options.promptParts ? parts.find((p) => !ADMITTED[options.promptParts!].has(p.type)) : undefined);
    const refusal = (part: PromptPart) => new AgentError('protocol_error', `[sigx ai-agent] session "${id}" accepts promptParts "${options.promptParts}" — ${part.type} part refused`);

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
            if (current && !current.settled) return options.steer ? core.steer(input, promptOptions) : failedTurn(turnId, new SessionBusyError(id, current.id));
            const parts = toPromptParts(input);
            const refused = refusedPart(parts);
            if (refused) return failedTurn(turnId, refusal(refused));
            steerHandler = null;
            queuedSteers = [];
            const turn = createTurn({
                log,
                turnId,
                input: parts,
                signals: [controller.signal, promptOptions?.signal],
                run: (driver) => {
                    const ctx: TurnContext = {
                        options: promptOptions ?? {},
                        onSteer: (handler) => {
                            steerHandler = handler;
                            const queued = queuedSteers;
                            queuedSteers = [];
                            for (const parts of queued) handler(parts);
                        },
                        resolve: (request, extra) => {
                            openRequests++;
                            setState('awaiting');
                            const parentCallId = extra?.parentCallId;
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
                                    driver.emit(parentCallId !== undefined ? { ...e, parentCallId } : e);
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
                    if (__DEV__ && queuedSteers.length) console.warn(`[sigx ai-agent] turn "${turnId}" ended with ${queuedSteers.length} steering input(s) its run never consumed (no ctx.onSteer)`);
                    steerHandler = null;
                    queuedSteers = [];
                    if (!closed) setState('idle');
                }
            });
            current = turn;
            setState('running');
            return turn;
        },
        steer(input, promptOptions) {
            const fallbackId = promptOptions?.turnId ?? generateId('turn');
            if (closed) return failedTurn(fallbackId, new AgentError('protocol_error', `[sigx ai-agent] session "${id}" is closed`));
            const turn = current;
            if (!turn || turn.settled) return failedTurn(fallbackId, new AgentError('protocol_error', `[sigx ai-agent] session "${id}": no turn is running to steer`));
            const parts = toPromptParts(input);
            const refused = refusedPart(parts);
            if (refused) return failedTurn(fallbackId, refusal(refused));
            // Capture the cursor before delivering, so the handle sees the
            // `user-message` the handler emits.
            const from: EventCursor = { epoch: log.epoch, seq: log.seq };
            if (steerHandler) steerHandler(parts);
            else queuedSteers.push(parts);
            return {
                id: turn.id,
                result: turn.result,
                [Symbol.asyncIterator]: () => filterTurn(log.subscribe(from), turn.id)[Symbol.asyncIterator]()
            };
        },
        attach(downstream) {
            attached.add(downstream);
            return () => {
                attached.delete(downstream);
            };
        },
        async respond(requestId, decision) {
            // A late answer — the policy, a timeout or a cancel got there first — is not an error.
            const own = pending.get(requestId);
            if (own) {
                own.resolve(decision);
                return;
            }
            // Answering at depth is what `subagents: 'control'` promises; an
            // unknown id on any other session stays a no-op.
            if (options.subagents !== 'control') return;
            for (const a of attached) await a.respond?.(requestId, decision);
        },
        async cancel(target) {
            if (target?.agentId === undefined || target.agentId === id) {
                current?.cancel();
                return;
            }
            if (options.subagents !== 'control') throw new AgentError('protocol_error', `[sigx ai-agent] session "${id}" cannot cancel a sub-agent (subagents: "${options.subagents ?? 'none'}")`);
            for (const a of attached) await a.cancel?.(target);
        },
        subscribe: (from) => log.subscribe(from),
        async close() {
            if (closed) return;
            controller.abort();
            const turn = current;
            if (turn && !turn.settled) await turn.result;
            for (const [, p] of pending) p.resolve({ type: 'cancel' });
            pending.clear();
            attached.clear();
            state = 'closed';
            log.append({ type: 'state', value: 'closed' });
            closed = true;
            log.close();
        }
    };
    return core;
}
