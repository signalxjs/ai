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
                    { type: 'reasoning', id: 'p1', text: 'hm', done: true, providerData: { sig: 1 } },
                    { type: 'text', id: 'p2', text: 'Hello' },
                    { type: 'tool', callId: 'c1', name: 'read', input: { path: 'x' }, category: 'read', status: 'completed', output: 'text' }
                ]
            }
        ]);
        expect(t.turn).toEqual({ turnId: 't1', stopReason: 'end_turn', usage: { outputTokens: 2 } });
    });

    it('marks a reasoning part done at part-end, so an empty OPEN one is distinguishable from one that thought nothing', () => {
        seq = 0;
        // A harness that redacts reasoning text (Claude Code) opens a real
        // reasoning part that never gets a delta — empty text alone cannot say
        // whether it is still thinking.
        const open = reduceAll([ev({ type: 'part-start', turnId: 't1', messageId: 'a1', partId: 'p1', kind: 'reasoning' })]);
        expect(open.messages[0]!.parts[0]).toEqual({ type: 'reasoning', id: 'p1', text: '' });
        const ended = reduceAll([ev({ type: 'part-start', turnId: 't1', messageId: 'a1', partId: 'p1', kind: 'reasoning' }), ev({ type: 'part-end', turnId: 't1', partId: 'p1' })]);
        expect(ended.messages[0]!.parts[0]).toEqual({ type: 'reasoning', id: 'p1', text: '', done: true });
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

    it('folds agent-start / agent-update into transcript.agents and links the spawning tool part', () => {
        seq = 0;
        const t = reduceAll([
            ev({ type: 'turn-start', turnId: 't1', input: [] }),
            ev({ type: 'tool-call', turnId: 't1', callId: 'c1', name: 'delegate' }),
            ev({ type: 'agent-start', turnId: 't1', parentCallId: 'c1', agentId: 'a1', callId: 'c1', kind: 'researcher', title: 'Research', description: 'find it', model: 'm', background: false }),
            ev({ type: 'agent-update', turnId: 't1', parentCallId: 'c1', agentId: 'a1', status: 'running', summary: 'reading', usage: { outputTokens: 5 } }),
            ev({ type: 'agent-update', turnId: 't1', parentCallId: 'c1', agentId: 'a1', status: 'completed', usage: { outputTokens: 9 }, costUsd: 0.2, output: 'found' })
        ]);
        expect(t.agents).toEqual({
            a1: {
                agentId: 'a1',
                callId: 'c1',
                depth: 0,
                turnId: 't1',
                seq: 3,
                kind: 'researcher',
                title: 'Research',
                description: 'find it',
                model: 'm',
                background: false,
                status: 'completed',
                summary: 'reading',
                usage: { outputTokens: 9 },
                costUsd: 0.2,
                output: 'found'
            }
        });
        expect(t.messages[0]!.parts[0]).toMatchObject({ type: 'tool', callId: 'c1', agentId: 'a1' });
        // Usage on an agent is cumulative: it replaces, and never lands on the session totals.
        expect(t.usage).toBeUndefined();
        expect(JSON.parse(JSON.stringify(t))).toEqual(t);
    });

    it('derives depth and parentAgentId from the call that made the spawning call; ignores duplicate starts and unknown updates', () => {
        seq = 0;
        const t = reduceAll([
            ev({ type: 'turn-start', turnId: 't1', input: [] }),
            ev({ type: 'tool-call', turnId: 't1', callId: 'c1', name: 'delegate' }),
            ev({ type: 'agent-start', turnId: 't1', parentCallId: 'c1', agentId: 'a1', callId: 'c1' }),
            ev({ type: 'tool-call', turnId: 't1', parentCallId: 'c1', callId: 'c2', name: 'delegate' }),
            // The harness claims depth 7; the call chain says 1 and wins.
            ev({ type: 'agent-start', turnId: 't1', parentCallId: 'c2', agentId: 'a2', callId: 'c2', depth: 7 }),
            ev({ type: 'tool-call', turnId: 't1', parentCallId: 'c2', callId: 'c3', name: 'delegate' }),
            ev({ type: 'agent-start', turnId: 't1', parentCallId: 'c3', agentId: 'a3', callId: 'c3' }),
            ev({ type: 'agent-start', turnId: 't1', parentCallId: 'c1', agentId: 'a1', callId: 'c1', title: 'again' }),
            ev({ type: 'agent-update', turnId: 't1', agentId: 'ghost', status: 'completed' }),
            ev({ type: 'agent-update', turnId: 't1', parentCallId: 'c3', agentId: 'a3', status: 'failed', error: { code: 'provider_error', message: 'boom' } })
        ]);
        expect(t.agents.a1).toMatchObject({ depth: 0, status: 'running' });
        expect(t.agents.a1).not.toHaveProperty('title');
        expect(t.agents.a2).toMatchObject({ depth: 1, parentAgentId: 'a1' });
        expect(t.agents.a3).toMatchObject({ depth: 2, parentAgentId: 'a2', status: 'failed', error: { code: 'provider_error', message: 'boom' } });
        expect(t.agents).not.toHaveProperty('ghost');
        // A call-less agent inside a sub-agent still finds its parent through the event's parentCallId.
        reduceAgentEvent(t, ev({ type: 'agent-start', turnId: 't1', parentCallId: 'c2', agentId: 'amb' }));
        expect(t.agents.amb).toMatchObject({ depth: 2, parentAgentId: 'a2' });
        // A call-bound ROOT agent: the chain is conclusive (the spawning call sits in
        // no other call), so the harness's own depth does not count either.
        reduceAgentEvent(t, ev({ type: 'tool-call', turnId: 't1', callId: 'c4', name: 'delegate' }));
        reduceAgentEvent(t, ev({ type: 'agent-start', turnId: 't1', parentCallId: 'c4', agentId: 'a4', callId: 'c4', depth: 5 }));
        expect(t.agents.a4).toMatchObject({ depth: 0 });
        expect(t.agents.a4).not.toHaveProperty('parentAgentId');
        // The chain is INconclusive when the spawning call sits in a call no agent-start
        // claimed (a nested tool that is not an agent): then the harness's depth stands.
        reduceAgentEvent(t, ev({ type: 'tool-call', turnId: 't1', callId: 'c5', name: 'plain' }));
        reduceAgentEvent(t, ev({ type: 'tool-call', turnId: 't1', parentCallId: 'c5', callId: 'c6', name: 'delegate' }));
        reduceAgentEvent(t, ev({ type: 'agent-start', turnId: 't1', parentCallId: 'c6', agentId: 'a6', callId: 'c6', depth: 3 }));
        expect(t.agents.a6).toMatchObject({ depth: 3 });
    });

    it('agents replay from any snapshot', () => {
        seq = 0;
        const events: AgentEvent[] = [
            ev({ type: 'turn-start', turnId: 't1', input: [] }),
            ev({ type: 'tool-call', turnId: 't1', callId: 'c1', name: 'delegate' }),
            ev({ type: 'agent-start', turnId: 't1', parentCallId: 'c1', agentId: 'a1', callId: 'c1' }),
            ev({ type: 'tool-call', turnId: 't1', parentCallId: 'c1', callId: 'c2', name: 'delegate' }),
            ev({ type: 'agent-start', turnId: 't1', parentCallId: 'c2', agentId: 'a2', callId: 'c2' }),
            ev({ type: 'agent-update', turnId: 't1', parentCallId: 'c2', agentId: 'a2', status: 'completed', usage: { outputTokens: 1 } }),
            ev({ type: 'tool-update', turnId: 't1', parentCallId: 'c1', callId: 'c2', status: 'completed' }),
            ev({ type: 'agent-update', turnId: 't1', parentCallId: 'c1', agentId: 'a1', status: 'completed' }),
            ev({ type: 'tool-update', turnId: 't1', callId: 'c1', status: 'completed' }),
            ev({ type: 'turn-end', turnId: 't1', stopReason: 'end_turn' })
        ];
        const full = reduceAll(events);
        for (let k = 0; k < events.length; k++) {
            const snap = reduceAll(events.slice(0, k));
            const copy = structuredClone(snap);
            for (const e of events.slice(k)) reduceAgentEvent(copy, e);
            expect(copy).toEqual(full);
        }
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

/**
 * Progressive tool input (#134).
 *
 * The contract is one part per call, never two: the deltas open the part and
 * the `tool-call` settles it IN PLACE. Everything else here follows from a
 * view being bound to that part while the arguments are still being written.
 */
describe('reduceAgentEvent: tool-input-delta', () => {
    const toolParts = (t: AgentTranscript) => t.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool');

    it('opens ONE part, fills it in, and the tool-call settles it in place', () => {
        seq = 0;
        const t = reduceAll([
            ev({ type: 'turn-start', turnId: 't1', input: [] }),
            ev({ type: 'tool-input-delta', turnId: 't1', messageId: 'a1', callId: 'c1', name: 'weather', delta: '{"ci' }),
            ev({ type: 'tool-input-delta', turnId: 't1', messageId: 'a1', callId: 'c1', name: 'weather', delta: 'ty":"Pa' }),
            ev({ type: 'tool-input-delta', turnId: 't1', messageId: 'a1', callId: 'c1', name: 'weather', delta: 'ris"}' }),
            ev({ type: 'tool-call', turnId: 't1', messageId: 'a1', callId: 'c1', name: 'weather', input: { city: 'Paris' }, category: 'read' })
        ]);

        const parts = toolParts(t);
        expect(parts).toHaveLength(1);
        expect(parts[0]).toMatchObject({ callId: 'c1', name: 'weather', status: 'pending', input: { city: 'Paris' }, category: 'read' });
        // The raw text is gone once there is nothing partial left to show.
        expect('inputText' in parts[0]!).toBe(false);
    });

    it('reads the best partial value out of what has arrived, and leaves input ABSENT when nothing parses', () => {
        seq = 0;
        const t = createTranscript('s');
        const part = () => toolParts(t)[0]!;

        reduceAgentEvent(t, ev({ type: 'tool-input-delta', turnId: 't1', callId: 'c1', name: 'weather', delta: '{"ci' }));
        expect(part().status).toBe('streaming');
        expect(part().inputText).toBe('{"ci');
        // A half-written KEY is dropped rather than guessed at, so the best
        // reading of `{"ci` is the empty object — `parsePartialJson` repairs
        // structurally, exactly as `applyChunk` does one level down.
        expect(part().input).toEqual({});

        reduceAgentEvent(t, ev({ type: 'tool-input-delta', turnId: 't1', callId: 'c1', name: 'weather', delta: 'ty":"Pa' }));
        // Now the key is whole, so the half-written VALUE reads as itself.
        expect(part().input).toEqual({ city: 'Pa' });
        expect(part().inputText).toBe('{"city":"Pa');
    });

    it('keeps the text and leaves input ABSENT when the arguments are not JSON at all', () => {
        seq = 0;
        // Not every harness streams JSON — a custom tool may stream raw text.
        const t = reduceAll([ev({ type: 'tool-input-delta', turnId: 't1', callId: 'c1', name: 'shell', delta: 'ls -la' })]);

        expect(toolParts(t)[0]!.inputText).toBe('ls -la');
        // ABSENT, not `undefined`: `'input' in part` is what a view branches on,
        // and `inputText` is what it shows meanwhile.
        expect('input' in toolParts(t)[0]!).toBe(false);
    });

    it('settles with no input when the call names none — a repaired prefix is not the arguments it was made with', () => {
        seq = 0;
        const t = reduceAll([
            ev({ type: 'tool-input-delta', turnId: 't1', callId: 'c1', name: 'weather', delta: '{"ci' }),
            // The deltas left a REPAIRED `{}` behind. The `tool-call` is what
            // says how the call was actually made, and it names no input — so
            // the part must end up exactly as the non-streaming path leaves
            // it, rather than keeping a guess the call did not confirm.
            ev({ type: 'tool-call', turnId: 't1', callId: 'c1', name: 'weather' })
        ]);

        const part = toolParts(t)[0]!;
        expect(part.status).toBe('pending');
        expect('input' in part).toBe(false);
        expect('inputText' in part).toBe(false);
    });

    it('ignores a delta that arrives after the call it describes — never reopens a settled part', () => {
        seq = 0;
        const t = reduceAll([
            ev({ type: 'tool-input-delta', turnId: 't1', callId: 'c1', name: 'weather', delta: '{"a":1}' }),
            ev({ type: 'tool-call', turnId: 't1', callId: 'c1', name: 'weather', input: { a: 1 } }),
            ev({ type: 'tool-update', turnId: 't1', callId: 'c1', status: 'completed', output: 'ok' }),
            ev({ type: 'tool-input-delta', turnId: 't1', callId: 'c1', name: 'weather', delta: 'junk' })
        ]);

        expect(toolParts(t)).toHaveLength(1);
        expect(toolParts(t)[0]).toMatchObject({ status: 'completed', input: { a: 1 }, output: 'ok' });
        expect('inputText' in toolParts(t)[0]!).toBe(false);
    });

    it('stops growing at the cap, and the call still settles with the real input', () => {
        seq = 0;
        const t = createTranscript('s');
        const chunk = 'x'.repeat(60_000);
        for (const delta of [chunk, chunk, chunk]) reduceAgentEvent(t, ev({ type: 'tool-input-delta', turnId: 't1', callId: 'c1', name: 'big', delta }));

        // A display degrades; it does not grow without bound over a stream we
        // do not control.
        expect(toolParts(t)[0]!.inputText!.length).toBe(100_000);
        reduceAgentEvent(t, ev({ type: 'tool-call', turnId: 't1', callId: 'c1', name: 'big', input: { ok: true } }));
        expect(toolParts(t)[0]).toMatchObject({ status: 'pending', input: { ok: true } });
    });

    it('falls back to the turn’s current assistant message when the delta names none', () => {
        seq = 0;
        const t = reduceAll([
            ev({ type: 'turn-start', turnId: 't1', input: [] }),
            ev({ type: 'part-start', turnId: 't1', messageId: 'a1', partId: 'p1', kind: 'text' }),
            ev({ type: 'tool-input-delta', turnId: 't1', callId: 'c1', name: 'weather', delta: '{}' })
        ]);

        expect(t.messages).toHaveLength(1);
        expect(t.messages[0]!.parts.map((p) => p.type)).toEqual(['text', 'tool']);
    });

    it('leaves a part unsettled when the turn ends mid-argument — a call written but never made', () => {
        seq = 0;
        const t = reduceAll([
            ev({ type: 'turn-start', turnId: 't1', input: [] }),
            ev({ type: 'tool-input-delta', turnId: 't1', callId: 'c1', name: 'weather', delta: '{"ci' }),
            ev({ type: 'turn-end', turnId: 't1', stopReason: 'cancelled' })
        ]);

        expect(toolParts(t)[0]).toMatchObject({ status: 'streaming', inputText: '{"ci' });
    });
});
