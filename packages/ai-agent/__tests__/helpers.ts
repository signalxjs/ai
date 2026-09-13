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
