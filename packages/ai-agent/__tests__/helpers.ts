/** Shared test helpers — collectors and a deterministic clock. */
import type { AgentEvent, AgentTurn } from '@sigx/ai-agent';

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
}

/** Drain a turn's events and its result together. */
export async function drain(turn: AgentTurn): Promise<{ events: AgentEvent[]; result: Awaited<AgentTurn['result']> }> {
    const events = await collect(turn);
    const result = await turn.result;
    return { events, result };
}

export function types(events: readonly AgentEvent[]): string[] {
    return events.map((e) => e.type);
}

export function textOf(events: readonly AgentEvent[]): string {
    return events
        .filter((e): e is Extract<AgentEvent, { type: 'part-delta' }> => e.type === 'part-delta')
        .map((e) => e.delta)
        .join('');
}

/** Count net `abort` listeners added to `signal` from now on (happy-dom's signals are not Node EventTargets). */
export function trackAbortListeners(signal: AbortSignal): () => number {
    let count = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (type === 'abort') count++;
        add(type, listener, options);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
        if (type === 'abort') count--;
        remove(type, listener, options);
    }) as typeof signal.removeEventListener;
    return () => count;
}

export function tick(ms = 0): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** Every event must survive the wire. */
export function expectJsonSafe(events: readonly AgentEvent[]): void {
    for (const e of events) {
        const copy = JSON.parse(JSON.stringify(e));
        if (JSON.stringify(copy) !== JSON.stringify(e)) throw new Error(`event does not round-trip through JSON: ${JSON.stringify(e)}`);
    }
}
