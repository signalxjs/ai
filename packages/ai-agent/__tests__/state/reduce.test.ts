import { describe, it, expect } from 'vitest';
import { createTranscript, createReducer, reduceAgentEvent, type AgentEvent, type UnstampedEvent, type AgentTranscript, type ReducerExtension } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';
import { collect } from '../helpers';

let seq = 0;
const ev = (payload: UnstampedEvent): AgentEvent => ({ ...payload, sessionId: 's', epoch: 1, seq: ++seq });

function reduceAll(events: readonly AgentEvent[], reducer = reduceAgentEvent): AgentTranscript {
    const t = createTranscript('s');
    for (const e of events) reducer(t, e);
    return t;
}

describe('reduceAgentEvent', () => {
    it('builds messages and parts in place and tracks the cursor', () => {
        seq = 0;
        const events: AgentEvent[] = [
            ev({ type: 'turn-start', turnId: 't1', input: [{ type: 'text', text: 'hi' }] }),
            ev({ type: 'user-message', turnId: 't1', messageId: 'u1', parts: [{ type: 'text', text: 'hi' }] }),
            ev({ type: 'part-start', turnId: 't1', messageId: 'a1', partId: 'p1', kind: 'reasoning' }),
            ev({ type: 'part-delta', turnId: 't1', partId: 'p1', delta: 'hm' }),
            ev({ type: 'part-end', turnId: 't1', partId: 'p1', providerData: { sig: 1 } }),
            ev({ type: 'part-start', turnId: 't1', messageId: 'a1', partId: 'p2', kind: 'text' }),
            ev({ type: 'part-delta', turnId: 't1', partId: 'p2', delta: 'Hel' }),
            ev({ type: 'part-delta', turnId: 't1', partId: 'p2', delta: 'lo' }),
            ev({ type: 'tool-call', turnId: 't1', callId: 'c1', name: 'read', input: { path: 'x' }, category: 'read' }),
            ev({ type: 'tool-update', turnId: 't1', callId: 'c1', status: 'in_progress' }),
            ev({ type: 'tool-update', turnId: 't1', callId: 'c1', status: 'completed', output: 'text' }),
            ev({ type: 'turn-end', turnId: 't1', stopReason: 'end_turn', usage: { outputTokens: 2 } })
        ];
        const t = createTranscript('s');
        const same = reduceAgentEvent(t, events[0]!);
        expect(same).toBe(t);
        for (const e of events.slice(1)) reduceAgentEvent(t, e);
        expect(t.epoch).toBe(1);
        expect(t.seq).toBe(12);
        expect(t.messages).toEqual([
            { id: 'u1', role: 'user', turnId: 't1', parts: [{ type: 'text', text: 'hi' }] },
            {
                id: 'a1',
                role: 'assistant',
                turnId: 't1',
                parts: [
                    { type: 'reasoning', id: 'p1', text: 'hm', providerData: { sig: 1 } },
                    { type: 'text', id: 'p2', text: 'Hello' },
                    { type: 'tool', callId: 'c1', name: 'read', input: { path: 'x' }, category: 'read', status: 'completed', output: 'text' }
                ]
            }
        ]);
        expect(t.turn).toEqual({ turnId: 't1', stopReason: 'end_turn', usage: { outputTokens: 2 } });
    });

    it('attaches a tool-call without messageId to the turn’s current assistant message, creating one when needed', () => {
        seq = 0;
        const t = reduceAll([ev({ type: 'turn-start', turnId: 't1', input: [] }), ev({ type: 'tool-call', turnId: 't1', callId: 'c1', name: 'x' }), ev({ type: 'tool-call', turnId: 't1', callId: 'c2', name: 'y' })]);
        expect(t.messages).toHaveLength(1);
        expect(t.messages[0]).toMatchObject({ id: 'a:t1:0', role: 'assistant', turnId: 't1' });
        expect(t.messages[0]!.parts.map((p) => (p as { callId: string }).callId)).toEqual(['c1', 'c2']);
    });

    it('nested events (parentCallId) create their own assistant message', () => {
        seq = 0;
        const t = reduceAll([
            ev({ type: 'turn-start', turnId: 't1', input: [] }),
            ev({ type: 'tool-call', turnId: 't1', callId: 'c1', name: 'delegate' }),
            ev({ type: 'part-start', turnId: 't1', parentCallId: 'c1', messageId: 'sub1', partId: 'sp', kind: 'text', actor: 'researcher' }),
            ev({ type: 'part-delta', turnId: 't1', parentCallId: 'c1', partId: 'sp', delta: 'found it' }),
            ev({ type: 'tool-call', turnId: 't1', parentCallId: 'c1', callId: 'c2', name: 'search' })
        ]);
        expect(t.messages.map((m) => m.id)).toEqual(['a:t1:0', 'sub1']);
        expect(t.messages[1]).toMatchObject({ actor: 'researcher', parentCallId: 'c1' });
        expect(t.messages[1]!.parts).toHaveLength(2);
    });

    it('tracks open requests, marks the tool awaiting, and records session grants on resolution', () => {
        seq = 0;
        const t = reduceAll([
            ev({ type: 'turn-start', turnId: 't1', input: [] }),
            ev({ type: 'tool-call', turnId: 't1', callId: 'c1', name: 'rm' }),
            ev({ type: 'request', turnId: 't1', requestId: 'r1', kind: 'permission', callId: 'c1', toolName: 'rm', permissionKey: 'rm:/x' })
        ]);
        expect(t.requests).toEqual({ r1: { requestId: 'r1', kind: 'permission', turnId: 't1', callId: 'c1', toolName: 'rm', permissionKey: 'rm:/x', seq: 3 } });
        expect(t.messages[0]!.parts[0]).toMatchObject({ requestId: 'r1', status: 'pending' });
        reduceAgentEvent(t, ev({ type: 'request-resolved', turnId: 't1', requestId: 'r1', outcome: 'allow', scope: 'session', by: 'client', at: 1 }));
        expect(t.requests).toEqual({});
        expect(t.messages[0]!.parts[0]).not.toHaveProperty('requestId');
        expect(t.grants).toEqual(['rm:/x']);
        // A policy-resolved grant has no preceding request: the key travels on the resolution.
        reduceAgentEvent(t, ev({ type: 'request-resolved', turnId: 't1', requestId: 'r2', outcome: 'allow', scope: 'session', by: 'policy', permissionKey: 'ls:/', at: 2 }));
        expect(t.grants).toEqual(['rm:/x', 'ls:/']);
    });

    it('usage: turn-scoped adds, session-scoped replaces; config, state and error are recorded', () => {
        seq = 0;
        const t = reduceAll([
            ev({ type: 'usage', scope: 'turn', usage: { inputTokens: 1, outputTokens: 2 }, costUsd: 0.1 }),
            ev({ type: 'usage', scope: 'turn', usage: { inputTokens: 3 }, costUsd: 0.2 }),
            ev({ type: 'config', options: [{ id: 'mode', label: 'Mode', values: [{ id: 'a' }], current: 'a' }] }),
            ev({ type: 'state', value: 'running' }),
            ev({ type: 'error', code: 'rate_limited', message: 'slow', recoverable: true })
        ]);
        expect(t.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
        expect(t.costUsd).toBeCloseTo(0.3);
        reduceAgentEvent(t, ev({ type: 'usage', scope: 'session', usage: { inputTokens: 100 }, costUsd: 1 }));
        expect(t.usage).toEqual({ inputTokens: 100 });
        expect(t.costUsd).toBe(1);
        expect(t.config[0]!.current).toBe('a');
        expect(t.state).toBe('running');
        expect(t.error).toEqual({ code: 'rate_limited', message: 'slow', recoverable: true });
    });

    it('ignores deltas for unknown parts and updates for unknown calls', () => {
        seq = 0;
        const t = reduceAll([ev({ type: 'part-delta', turnId: 't1', partId: 'nope', delta: 'x' }), ev({ type: 'tool-update', turnId: 't1', callId: 'nope', status: 'completed' })]);
        expect(t.messages).toEqual([]);
    });

    it('extension reducers own their namespace; unknown namespaces are ignored', () => {
        seq = 0;
        const counting: ReducerExtension = {
            ns: 'test',
            reduce(t, e) {
                const state = (t.ext.test ??= { names: [] as string[] }) as { names: string[] };
                state.names.push(e.name);
            }
        };
        const reducer = createReducer({ extensions: [counting] });
        const t = reduceAll([ev({ type: 'ext', ns: 'test', name: 'a', data: 1 }), ev({ type: 'ext', ns: 'other', name: 'b', data: 2 }), ev({ type: 'ext', ns: 'test', name: 'c', data: 3 })], reducer);
        expect(t.ext).toEqual({ test: { names: ['a', 'c'] } });
    });

    it('is deterministic: reducing from any snapshot equals the full reduction', async () => {
        const agent = mockAgent({
            script: [[{ reasoning: 'hm', text: 'Hello there' }, { tool: { name: 'read', input: { p: 1 }, output: 'ok', permissionKey: 'read' } }, { ext: { ns: 'x', name: 'y', data: {} } }, { usage: { outputTokens: 3 } }]]
        });
        const session = await agent.session();
        const all = collect(session.subscribe());
        const turn = session.prompt('go');
        for await (const e of turn) if (e.type === 'request') await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'session' });
        await session.close();
        const events = await all;
        const full = reduceAll(events);
        for (let k = 0; k < events.length; k++) {
            const snapshot = reduceAll(events.slice(0, k));
            for (const e of events.slice(k)) reduceAgentEvent(snapshot, e);
            expect(snapshot).toEqual(full);
        }
        expect(full.grants).toEqual(['read']);
        expect(full.state).toBe('closed');
        expect(JSON.parse(JSON.stringify(full))).toEqual(full);
    });

    // Every write must go THROUGH the transcript it was handed.
    //
    // `./app` gives the reducer a reactive proxy and renders what it
    // notifies. A reducer that keeps the object literal it just stored --
    // `push(x); return x`, `(t.turn = {…})`, `(o[k] ??= {…})` -- writes to the
    // raw object behind the proxy instead, and those writes notify nobody.
    // It only shows up when something starts observing between the store and
    // the write, which is exactly what a reactive container does: storing the
    // message re-renders the list, the new row reads `parts` while it is
    // still empty, and the part pushed a line later never arrives.
    //
    // A recording proxy catches it with no reactivity involved: anything the
    // reducer mutates without the proxy seeing it is an alias.
    it('writes only through the transcript it was given, never a retained literal', () => {
        seq = 0;
        const writes: string[] = [];
        const seen = (target: object, path: string): object =>
            new Proxy(target, {
                get(o, k, r) {
                    const v = Reflect.get(o, k) as unknown;
                    // Bound to the PROXY, so `push` writes the element and the
                    // new length through the trap below, as a reactive
                    // container's array would notify for them.
                    if (typeof v === 'function') return (v as (...a: unknown[]) => unknown).bind(r);
                    return v !== null && typeof v === 'object' ? seen(v as object, `${path}.${String(k)}`) : v;
                },
                set(o, k, v) {
                    writes.push(`${path}.${String(k)}`);
                    return Reflect.set(o, k, v);
                },
                deleteProperty(o, k) {
                    writes.push(`delete ${path}.${String(k)}`);
                    return Reflect.deleteProperty(o, k);
                }
            });

        const t = seen(createTranscript('s'), 't') as AgentTranscript;
        reduceAgentEvent(t, ev({ type: 'part-start', turnId: 't1', messageId: 'm1', partId: 'p1', kind: 'text' }));
        reduceAgentEvent(t, ev({ type: 'part-delta', turnId: 't1', partId: 'p1', delta: 'hi' }));
        reduceAgentEvent(t, ev({ type: 'tool-call', turnId: 't1', messageId: 'm2', callId: 'c1', name: 'search' }));
        reduceAgentEvent(t, ev({ type: 'turn-end', turnId: 'other', stopReason: 'end_turn' }));

        // The message the reducer created, then filled: both halves observed.
        expect(writes).toContain('t.messages.0');
        expect(writes).toContain('t.messages.0.parts.0');
        expect(writes).toContain('t.messages.0.parts.0.text');
        // A tool call that creates its own assistant message, likewise.
        expect(writes).toContain('t.messages.1');
        expect(writes).toContain('t.messages.1.parts.0');
        // A `turn-end` with no matching `turn-start` creates the turn, then
        // writes its outcome onto it.
        expect(writes).toContain('t.turn');
        expect(writes).toContain('t.turn.stopReason');

        expect(t.messages[0]!.parts[0]).toEqual({ type: 'text', id: 'p1', text: 'hi' });
        expect(t.turn?.stopReason).toBe('end_turn');
    });
});
