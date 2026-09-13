import { describe, it, expect } from 'vitest';
import { createTranscript, createReducer, type AgentEvent, type UnstampedEvent } from '@sigx/ai-agent';
import { codingExtension, codingEvent, codingState, isCodingEvent, CODING_NS } from '@sigx/ai-agent/coding';

let seq = 0;
const ev = (payload: UnstampedEvent): AgentEvent => ({ ...payload, sessionId: 's', epoch: 1, seq: ++seq });

describe('coding extension events and reducer', () => {
    it('codingEvent builds a namespaced ext event and isCodingEvent narrows it', () => {
        const e = ev({ ...codingEvent('diff', { path: 'a.ts', newText: 'x' }, { parentCallId: 'c1' }), turnId: 't1' });
        expect(e).toMatchObject({ type: 'ext', ns: CODING_NS, name: 'diff', data: { path: 'a.ts', newText: 'x' }, parentCallId: 'c1' });
        expect(isCodingEvent(e)).toBe(true);
        expect(isCodingEvent(e, 'diff')).toBe(true);
        expect(isCodingEvent(e, 'plan')).toBe(false);
        expect(isCodingEvent(ev({ type: 'ext', ns: 'other', name: 'diff', data: {} }))).toBe(false);
    });

    it('accumulates diffs (tagged), bounded terminal output, the latest plan and changed files', () => {
        seq = 0;
        const reduce = createReducer({ extensions: [codingExtension({ maxTerminalBytes: 8 })] });
        const t = createTranscript('s');
        const events: AgentEvent[] = [
            ev({ ...codingEvent('diff', { path: 'a.ts', oldText: '1', newText: '2' }, { parentCallId: 'c1' }), turnId: 't1' }),
            ev({ ...codingEvent('terminal', { terminalId: 'term1', stream: 'stdout', delta: 'hello ' }), turnId: 't1' }),
            ev({ ...codingEvent('terminal', { terminalId: 'term1', stream: 'stderr', delta: 'world!' }), turnId: 't1' }),
            ev({ ...codingEvent('terminal-exit', { terminalId: 'term1', exitCode: 0 }), turnId: 't1' }),
            ev({ ...codingEvent('plan', { entries: [{ content: 'a', status: 'pending' }] }), turnId: 't1' }),
            ev({ ...codingEvent('plan', { entries: [{ content: 'a', status: 'completed', priority: 'high' }] }), turnId: 't1' }),
            ev({ ...codingEvent('files-changed', { paths: ['a.ts', 'b.ts'] }), turnId: 't1' }),
            ev({ ...codingEvent('diff', { path: 'b.ts', unifiedDiff: '--- b\n+++ b' }), turnId: 't2' })
        ];
        for (const e of events) reduce(t, e);
        const state = codingState(t)!;
        expect(state.diffs).toEqual([
            { path: 'a.ts', oldText: '1', newText: '2', turnId: 't1', callId: 'c1' },
            { path: 'b.ts', unifiedDiff: '--- b\n+++ b', turnId: 't2' }
        ]);
        expect(state.terminals.term1).toEqual({ output: 'o world!', truncated: true, exitCode: 0 });
        expect(state.plan).toEqual({ entries: [{ content: 'a', status: 'completed', priority: 'high' }] });
        expect(state.filesChanged).toEqual(['a.ts', 'b.ts']);
        expect(JSON.parse(JSON.stringify(t))).toEqual(t);
    });

    it('is replayable from any snapshot', () => {
        seq = 0;
        const reduce = createReducer({ extensions: [codingExtension()] });
        const events: AgentEvent[] = [
            ev({ ...codingEvent('terminal', { terminalId: 'x', stream: 'stdout', delta: 'a' }), turnId: 't1' }),
            ev({ ...codingEvent('diff', { path: 'p' }), turnId: 't1' }),
            ev({ ...codingEvent('terminal-exit', { terminalId: 'x', exitCode: 1, signal: 'SIGTERM' }), turnId: 't1' })
        ];
        const full = createTranscript('s');
        for (const e of events) reduce(full, e);
        for (let k = 0; k < events.length; k++) {
            const snap = createTranscript('s');
            for (const e of events.slice(0, k)) reduce(snap, e);
            const copy = structuredClone(snap);
            for (const e of events.slice(k)) reduce(copy, e);
            expect(copy).toEqual(full);
        }
        expect(codingState(createTranscript('s'))).toBeUndefined();
    });
});
