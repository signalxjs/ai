/**
 * Coding extension events — typed `ext` events in the `coding` namespace: a
 * file diff, terminal output, a plan, the set of changed files. Adapters
 * emit them alongside the domain-neutral `tool-call` / `tool-update`; the
 * reducer plugin in `./reducer.js` folds them into `transcript.ext.coding`.
 */

import type { AgentEvent, EventOf, UnstampedEvent } from '../protocol/index.js';

export const CODING_NS = 'coding';

export interface CodingDiff {
    readonly path: string;
    readonly oldText?: string;
    readonly newText?: string;
    readonly unifiedDiff?: string;
}

export interface CodingTerminal {
    readonly terminalId: string;
    readonly stream: 'stdout' | 'stderr';
    readonly delta: string;
}

export interface CodingTerminalExit {
    readonly terminalId: string;
    readonly exitCode: number | null;
    readonly signal?: string;
}

export interface CodingPlanEntry {
    readonly content: string;
    readonly status: 'pending' | 'in_progress' | 'completed';
    readonly priority?: 'high' | 'medium' | 'low';
}

export interface CodingPlan {
    readonly entries: readonly CodingPlanEntry[];
}

export interface CodingFilesChanged {
    readonly paths: readonly string[];
}

export interface CodingEventMap {
    readonly diff: CodingDiff;
    readonly terminal: CodingTerminal;
    readonly 'terminal-exit': CodingTerminalExit;
    readonly plan: CodingPlan;
    readonly 'files-changed': CodingFilesChanged;
}

export type CodingEventName = keyof CodingEventMap;

/** An `ext` event in the `coding` namespace, typed by name. */
export type CodingEvent<N extends CodingEventName = CodingEventName> = EventOf<'ext'> & { readonly ns: typeof CODING_NS; readonly name: N; readonly data: CodingEventMap[N] };

/** Build a coding `ext` event for `driver.emit`. */
export function codingEvent<N extends CodingEventName>(name: N, data: CodingEventMap[N], context?: { readonly parentCallId?: string }): UnstampedEvent {
    return { type: 'ext', ns: CODING_NS, name, data, ...(context?.parentCallId !== undefined ? { parentCallId: context.parentCallId } : {}) };
}

export function isCodingEvent(event: AgentEvent): event is CodingEvent;
export function isCodingEvent<N extends CodingEventName>(event: AgentEvent, name: N): event is CodingEvent<N>;
export function isCodingEvent(event: AgentEvent, name?: CodingEventName): boolean {
    return event.type === 'ext' && event.ns === CODING_NS && (name === undefined || event.name === name);
}
