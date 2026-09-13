/**
 * `codingExtension` — the reducer plugin for coding events. Keeps, under
 * `transcript.ext.coding`: every diff (tagged with its turn and tool call),
 * bounded terminal output per terminal, the latest plan, and the changed
 * files. Deterministic like the core reducer: no clocks, no generated ids.
 */

import type { AgentTranscript, ReducerExtension } from '../state/index.js';
import { CODING_NS, type CodingDiff, type CodingPlan } from './extensions.js';

export interface CodingDiffRecord extends CodingDiff {
    readonly turnId?: string;
    /** The tool call that produced the diff (the event's `parentCallId`), when known. */
    readonly callId?: string;
}

export interface CodingTerminalState {
    /** Interleaved stdout/stderr as it arrived, trimmed from the front past `maxTerminalChars`. */
    output: string;
    truncated: boolean;
    exitCode?: number | null;
    signal?: string;
}

export interface CodingState {
    diffs: CodingDiffRecord[];
    terminals: Record<string, CodingTerminalState>;
    plan?: CodingPlan;
    filesChanged: string[];
}

export interface CodingExtensionOptions {
    /** Characters (UTF-16 code units) kept per terminal. Default 65 536. */
    readonly maxTerminalChars?: number;
}

export function codingExtension(options: CodingExtensionOptions = {}): ReducerExtension {
    const max = options.maxTerminalChars ?? 65_536;
    return {
        ns: CODING_NS,
        reduce(t, e) {
            const state = codingStateOf(t);
            switch (e.name) {
                case 'diff': {
                    const d = e.data as CodingDiff;
                    state.diffs.push({
                        ...d,
                        ...(e.turnId !== undefined ? { turnId: e.turnId } : {}),
                        ...(e.parentCallId !== undefined ? { callId: e.parentCallId } : {})
                    });
                    if (!state.filesChanged.includes(d.path)) state.filesChanged.push(d.path);
                    break;
                }
                case 'terminal': {
                    const { terminalId, delta } = e.data as { terminalId: string; delta: string };
                    const term = terminalOf(state, terminalId);
                    term.output += delta;
                    if (term.output.length > max) {
                        term.output = term.output.slice(term.output.length - max);
                        term.truncated = true;
                    }
                    break;
                }
                case 'terminal-exit': {
                    const { terminalId, exitCode, signal } = e.data as { terminalId: string; exitCode: number | null; signal?: string };
                    const term = terminalOf(state, terminalId);
                    term.exitCode = exitCode;
                    if (signal !== undefined) term.signal = signal;
                    break;
                }
                case 'plan':
                    state.plan = e.data as CodingPlan;
                    break;
                case 'files-changed':
                    for (const p of (e.data as { paths: readonly string[] }).paths) if (!state.filesChanged.includes(p)) state.filesChanged.push(p);
                    break;
            }
        }
    };
}

/**
 * The coding state of a transcript, created on first use.
 *
 * Assign, then read BACK out of the transcript — `(x ??= {…})` evaluates to
 * the literal, and on a reactive transcript that literal is the raw object
 * behind the proxy. Mutating it would fire no notification, so the first
 * coding event of a session would never reach the view.
 */
export function codingStateOf(transcript: AgentTranscript): CodingState {
    transcript.ext[CODING_NS] ??= { diffs: [], terminals: {}, filesChanged: [] } satisfies CodingState;
    return transcript.ext[CODING_NS] as CodingState;
}

/** One terminal's state, created on first use — read back, never the literal. */
function terminalOf(state: CodingState, terminalId: string): CodingTerminalState {
    state.terminals[terminalId] ??= { output: '', truncated: false };
    return state.terminals[terminalId]!;
}

/** The coding state if any coding event was reduced, else `undefined`. */
export function codingState(transcript: AgentTranscript): CodingState | undefined {
    return transcript.ext[CODING_NS] as CodingState | undefined;
}
