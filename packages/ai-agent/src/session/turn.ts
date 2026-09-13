/**
 * `createTurn` — the turn every adapter reuses.
 *
 * The adapter supplies `run(driver)`; the driver's `emit` is the only way
 * events enter the turn, and it feeds both the session log (stamping) and the
 * turn's own buffer, so `for await (const e of turn)` and `await turn.result`
 * both work whether or not anyone iterates. `end()` closes the turn with a
 * `turn-end`; a run that aborts ends `cancelled`, one that throws ends
 * `error`, one that forgets to end is a protocol error — never a hang.
 */

import type { AgentEvent, PromptPart, StopReason, UnstampedEvent } from '../protocol/index.js';
import type { ErrorInfo } from '../protocol/index.js';
import { AgentError } from '../protocol/index.js';
import type { Usage } from '@sigx/ai';
import { anySignal, isAbort } from '../utils/abort.js';
import { generateId } from '../utils/id.js';
import { createQueue } from '../utils/queue.js';
import type { AgentTurn, TurnResult } from './agent.js';
import type { SessionLog } from './event-log.js';

export interface TurnEndInit {
    readonly stopReason: StopReason;
    readonly usage?: Usage;
    readonly costUsd?: number;
    readonly output?: unknown;
    readonly error?: ErrorInfo;
}

/** What `run` receives. */
export interface TurnDriver {
    readonly turnId: string;
    /** Aborts on `cancel()`, on the prompt's signal, or on the session's. */
    readonly signal: AbortSignal;
    readonly ended: boolean;
    /** Stamp and publish; `turnId` (and `parentCallId` when nested) are filled in. */
    emit(event: UnstampedEvent): AgentEvent;
    /** Publish the `turn-end`; further `emit`s are dropped. */
    end(result: TurnEndInit): void;
}

export interface CreateTurnOptions {
    readonly log: SessionLog;
    readonly input: readonly PromptPart[];
    readonly turnId?: string;
    /** Set when this turn runs inside a parent tool call (delegation). */
    readonly parentCallId?: string;
    /** The session's and the prompt's signals; the turn adds its own for `cancel()`. */
    readonly signals?: ReadonlyArray<AbortSignal | undefined>;
    run(driver: TurnDriver): Promise<void>;
    /** Called once with the result, after `turn-end` is in the log. */
    onSettle?(result: TurnResult): void;
}

export interface ManagedTurn extends AgentTurn {
    readonly settled: boolean;
    cancel(reason?: unknown): void;
}

export function createTurn(options: CreateTurnOptions): ManagedTurn {
    const { log } = options;
    const turnId = options.turnId ?? generateId('turn');
    const { signal, abort } = anySignal(options.signals ?? []);
    const buffer = createQueue<AgentEvent>();
    let ended = false;
    let settled = false;
    let startSeq = 0;
    let resolveResult!: (r: TurnResult) => void;
    const result = new Promise<TurnResult>((resolve) => {
        resolveResult = resolve;
    });

    const emit = (event: UnstampedEvent): AgentEvent => {
        const contextual: UnstampedEvent = {
            ...event,
            turnId,
            ...(options.parentCallId !== undefined && event.parentCallId === undefined ? { parentCallId: options.parentCallId } : {})
        };
        if (ended) {
            // Dropped, but returned in the same shape a live event would have —
            // `seq: -1` is the tell.
            if (__DEV__) console.warn(`[sigx ai-agent] event "${event.type}" emitted after turn "${turnId}" ended; dropped`);
            return { ...contextual, sessionId: log.sessionId, epoch: log.epoch, seq: -1 };
        }
        const stamped = log.append(contextual);
        buffer.push(stamped);
        return stamped;
    };

    const end = (init: TurnEndInit): void => {
        if (ended) return;
        // A turn whose own signal fired is a cancelled turn, whatever the
        // harness reported — unless it failed outright.
        const stopReason: StopReason = signal.aborted && init.stopReason !== 'error' ? 'cancelled' : init.stopReason;
        emit({
            type: 'turn-end',
            stopReason,
            ...(init.usage !== undefined ? { usage: init.usage } : {}),
            ...(init.costUsd !== undefined ? { costUsd: init.costUsd } : {}),
            ...(init.output !== undefined ? { output: init.output } : {}),
            ...(init.error !== undefined ? { error: init.error } : {})
        });
        ended = true;
        buffer.end();
        const value: TurnResult = {
            turnId,
            stopReason,
            ...(init.usage !== undefined ? { usage: init.usage } : {}),
            ...(init.costUsd !== undefined ? { costUsd: init.costUsd } : {}),
            ...(init.output !== undefined ? { output: init.output } : {}),
            ...(init.error !== undefined ? { error: init.error } : {})
        };
        settled = true;
        resolveResult(value);
        options.onSettle?.(value);
    };

    const driver: TurnDriver = {
        turnId,
        signal,
        get ended() {
            return ended;
        },
        emit,
        end
    };

    startSeq = emit({ type: 'turn-start', input: options.input }).seq;

    // The run starts on a microtask so the caller holds the turn first.
    void Promise.resolve().then(async () => {
        // Cancelled before it could start: no work, one turn-end.
        if (signal.aborted) {
            end({ stopReason: 'cancelled' });
            return;
        }
        try {
            await options.run(driver);
            if (!ended) {
                if (signal.aborted) end({ stopReason: 'cancelled' });
                else {
                    const error: ErrorInfo = { code: 'protocol_error', message: `turn "${turnId}" finished without a turn-end` };
                    emit({ type: 'error', code: error.code, message: error.message, recoverable: false });
                    end({ stopReason: 'error', error });
                }
            }
        } catch (e) {
            if (ended) return;
            if (isAbort(e) || signal.aborted) {
                end({ stopReason: 'cancelled' });
                return;
            }
            const error: ErrorInfo =
                e instanceof AgentError ? { code: e.code, message: e.message } : { code: 'provider_error', message: e instanceof Error ? e.message : String(e) };
            emit({ type: 'error', code: error.code, message: error.message, recoverable: e instanceof AgentError ? e.recoverable : false });
            end({ stopReason: 'error', error });
        }
    });

    let firstIterator = true;
    const turn: ManagedTurn = {
        id: turnId,
        result,
        get settled() {
            return settled;
        },
        cancel(reason) {
            abort(reason);
        },
        [Symbol.asyncIterator]() {
            // The first consumer drains the turn's own buffer (nothing missed,
            // however late it starts); later ones replay from the log.
            if (firstIterator) {
                firstIterator = false;
                return buffer[Symbol.asyncIterator]();
            }
            return filterTurn(log.subscribe({ epoch: log.epoch, seq: startSeq - 1 }), turnId)[Symbol.asyncIterator]();
        }
    };
    return turn;
}

/** The events of one turn, up to and including its `turn-end`. */
export async function* filterTurn(events: AsyncIterable<AgentEvent>, turnId: string): AsyncGenerator<AgentEvent> {
    for await (const e of events) {
        if (e.turnId !== turnId) continue;
        yield e;
        if (e.type === 'turn-end') return;
    }
}

/** A turn that never started: `result` rejects and iteration throws with `error`. */
export function failedTurn(turnId: string, error: Error): AgentTurn {
    const result = Promise.reject(error);
    result.catch(() => {});
    return {
        id: turnId,
        result,
        [Symbol.asyncIterator]() {
            return {
                next: () => Promise.reject(error),
                return: () => Promise.resolve({ value: undefined, done: true as const }),
                [Symbol.asyncIterator]() {
                    return this;
                }
            };
        }
    };
}
