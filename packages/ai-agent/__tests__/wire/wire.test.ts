import { describe, it, expect } from 'vitest';
import { allowAll, memoryEventLog, createTranscript, reduceAgentEvent, SessionBusyError, AgentError, type AgentEvent, type AgentSession } from '@sigx/ai-agent';
import { serveSession, connectSession, type ServedSession, type SessionTransport, type WireCommand, type WireCommandPayload, type WireFrame, type Cursor } from '@sigx/ai-agent/wire';
import { mockAgent, MOCK_CAPABILITIES, type MockStep } from '@sigx/ai-agent/testing';
import { collect, drain, textOf, tick } from '../helpers';

const inMemory = (served: ServedSession, principal?: unknown): SessionTransport => ({ send: (c) => served.handleCommand(c, principal), events: (from, o) => served.events(from, o) });

async function serve(script: MockStep[][], sessionOptions: Parameters<AgentSession['prompt']> extends never ? never : Record<string, unknown> = {}, serveOptions: Partial<Parameters<typeof serveSession>[1]> = {}) {
    const agent = mockAgent({ script });
    const session = await agent.session(sessionOptions);
    const served = serveSession(session, { agentId: agent.id, capabilities: agent.capabilities, ...serveOptions });
    return { agent, session, served };
}

const seqs = (events: readonly AgentEvent[]) => events.map((e) => `${e.epoch}:${e.seq}`);

describe('serveSession / connectSession', () => {
    it('prompts through the wire: events, result, ref and capabilities', async () => {
        const { session, served } = await serve([[{ reasoning: 'hm', text: 'Hello there' }, { usage: { outputTokens: 2 } }]]);
        const remote = await connectSession(inMemory(served));
        expect(remote.id).toBe(session.id);
        expect(remote.agentId).toBe('mock');
        expect(remote.capabilities).toEqual(MOCK_CAPABILITIES);
        expect(remote.ref).toEqual(session.ref);
        expect(remote.connected).toBe(true);
        const turn = remote.prompt('hi', { turnId: 'client-turn-1' });
        expect(turn.id).toBe('client-turn-1');
        const { events, result } = await drain(turn);
        expect(events[0]).toMatchObject({ type: 'turn-start', turnId: 'client-turn-1' });
        expect(textOf(events)).toBe('hmHello there');
        expect(result).toEqual({ turnId: 'client-turn-1', stopReason: 'end_turn', usage: { outputTokens: 2 } });
        // The same events, with the remote stamps, are what a local subscriber would have seen.
        const local = await collect(until(session.subscribe({ epoch: 0, seq: 0 }), 20));
        expect(events.every((e) => local.some((l) => l.seq === e.seq && l.type === e.type))).toBe(true);
        await remote.close();
        expect(remote.connected).toBe(false);
        await served.close();
    });

    it('a late joiner replays from a cursor with no gaps or duplicates; two observers agree', async () => {
        const { session, served } = await serve([[{ text: 'one two three' }], [{ text: 'four' }]]);
        await session.prompt('a').result;
        const all = await collect(served.events({ epoch: 0, seq: 0 }, { signal: AbortSignal.timeout(50) }));
        expect(all[0]!.kind).toBe('hello');
        const frames = all.filter((f): f is Extract<WireFrame, { kind: 'event' }> => f.kind === 'event');
        expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i + 1));
        const observer = await connectSession(inMemory(served), { from: { epoch: 0, seq: 0 } });
        const viewer = await connectSession(inMemory(served), { from: { epoch: 0, seq: 0 } });
        await tick(5);
        const a = await collect(until(observer.subscribe({ epoch: 0, seq: 0 }), 20));
        const b = await collect(until(viewer.subscribe({ epoch: 0, seq: 0 }), 20));
        expect(seqs(a)).toEqual(frames.map((f) => `1:${f.seq}`));
        expect(seqs(b)).toEqual(seqs(a));
        // A second turn reaches both, still gapless.
        await session.prompt('b').result;
        await tick(5);
        expect(observer.cursor).toEqual(viewer.cursor);
        expect(observer.cursor!.seq).toBeGreaterThan(frames.length);
        observer.disconnect();
        viewer.disconnect();
    });

    it('reconnects from the last cursor after the stream breaks, without gaps or duplicates', async () => {
        const { served } = await serve([[{ text: 'a b c d e f g h', delayMs: 2 }]]);
        let breaks = 0;
        const transport: SessionTransport = {
            send: (c) => served.handleCommand(c),
            events: (from, o) =>
                (async function* () {
                    let n = 0;
                    for await (const f of served.events(from, o)) {
                        yield f;
                        // Break the stream once, a few events in.
                        if (breaks === 0 && ++n === 5) {
                            breaks++;
                            throw new Error('connection reset');
                        }
                    }
                })()
        };
        const remote = await connectSession(transport, { reconnect: { backoffMs: () => 1 } });
        const { events, result } = await drain(remote.prompt('go'));
        expect(breaks).toBe(1);
        expect(result.stopReason).toBe('end_turn');
        expect(textOf(events)).toBe('a b c d e f g h');
        const all = await collect(until(remote.subscribe({ epoch: 0, seq: 0 }), 20));
        expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
        remote.disconnect();
    });

    it('a broken stream with reconnect: false ends the client', async () => {
        const { served } = await serve([[{ text: 'x' }]]);
        const transport: SessionTransport = {
            send: (c) => served.handleCommand(c),
            events: (from, o) =>
                (async function* () {
                    for await (const f of served.events(from, o)) {
                        yield f;
                        if (f.kind === 'event' && f.event.type === 'user-message') throw new Error('gone');
                    }
                })()
        };
        const remote = await connectSession(transport, { reconnect: false });
        await expect(remote.prompt('go').result).rejects.toThrow(/connection ended/);
        expect(remote.connected).toBe(false);
    });

    it('authorize refuses commands and their replays; duplicate commandIds run once', async () => {
        let prompts = 0;
        const agent = mockAgent({ respond: () => (prompts++, [{ text: 'ok' }]) });
        const session = await agent.session();
        const served = serveSession(session, { agentId: agent.id, capabilities: agent.capabilities, authorize: (command, principal) => principal === 'owner' || command.type !== 'close' });
        const cmd = (c: { commandId: string } & WireCommandPayload): WireCommand => ({ v: 1, ...c });
        const denied = await served.handleCommand(cmd({ commandId: 'x1', type: 'close' }), 'viewer');
        expect(denied).toEqual({ v: 1, kind: 'error', commandId: 'x1', code: 'unauthorized', message: expect.stringContaining('close') });
        expect(await served.handleCommand(cmd({ commandId: 'x1', type: 'close' }), 'viewer')).toMatchObject({ code: 'unauthorized' });
        const first = await served.handleCommand(cmd({ commandId: 'p1', type: 'prompt', turnId: 't1', input: [{ type: 'text', text: 'hi' }] }), 'viewer');
        const again = await served.handleCommand(cmd({ commandId: 'p1', type: 'prompt', turnId: 't1', input: [{ type: 'text', text: 'hi' }] }), 'viewer');
        expect(first).toEqual({ v: 1, kind: 'ack', commandId: 'p1', turnId: 't1' });
        expect(again).toEqual(first);
        await tick(5);
        expect(prompts).toBe(1);
        expect(await served.handleCommand({ nope: true } as unknown as WireCommand)).toMatchObject({ kind: 'error', code: 'invalid' });
        expect(await served.handleCommand(cmd({ commandId: 'c1', type: 'configure', patch: { a: 'b' } }), 'owner')).toMatchObject({ kind: 'ack' });
        expect(await served.handleCommand(cmd({ commandId: 'z', type: 'close' }), 'owner')).toMatchObject({ kind: 'ack' });
    });

    it('a busy session answers error busy → SessionBusyError on the client turn', async () => {
        const { served } = await serve([[{ text: 'slow slow slow', delayMs: 10 }], [{ text: 'second' }]]);
        const remote = await connectSession(inMemory(served));
        const first = remote.prompt('a');
        const second = remote.prompt('b');
        await expect(second.result).rejects.toBeInstanceOf(SessionBusyError);
        await expect(collect(second)).rejects.toBeInstanceOf(SessionBusyError);
        expect((await first.result).stopReason).toBe('end_turn');
        remote.disconnect();
    });

    it('respond travels over the wire; a late respond acks and the outcome is on request-resolved', async () => {
        const { served } = await serve([[{ tool: { name: 'rm', input: {} } }, { text: 'done' }]]);
        const remote = await connectSession(inMemory(served));
        const turn = remote.prompt('go');
        const seen: AgentEvent[] = [];
        for await (const e of turn) {
            seen.push(e);
            if (e.type === 'request') await remote.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
        }
        expect(seen.find((e) => e.type === 'request-resolved')).toMatchObject({ by: 'client', outcome: 'allow' });
        expect(seen.find((e) => e.type === 'tool-update' && e.status === 'completed')).toBeDefined();
        // Late: the request is long resolved — still an ack.
        await expect(remote.respond('stale', { type: 'cancel' })).resolves.toBeUndefined();
        // Policy-resolved: the client never sees a request, only the resolution.
        const auto = await serve([[{ tool: { name: 'rm', input: {} } }]], { policy: allowAll });
        const r2 = await connectSession(inMemory(auto.served));
        const { events } = await drain(r2.prompt('go'));
        expect(events.filter((e) => e.type === 'request')).toHaveLength(0);
        expect(events.find((e) => e.type === 'request-resolved')).toMatchObject({ by: 'policy' });
        remote.disconnect();
        r2.disconnect();
    });

    it('cancel over the wire ends the turn cancelled', async () => {
        const { served } = await serve([[{ tool: { name: 'slow', delayMs: 5000 } }, { text: 'never' }]], { policy: allowAll });
        const remote = await connectSession(inMemory(served));
        const turn = remote.prompt('go');
        for await (const e of turn) if (e.type === 'tool-update' && e.status === 'in_progress') await remote.cancel();
        expect((await turn.result).stopReason).toBe('cancelled');
        remote.disconnect();
    });

    it('a Standard Schema cannot cross the wire; a JSON Schema output does', async () => {
        const { served } = await serve([[{ text: '{"ok":true}' }, { output: { ok: true } }]]);
        const remote = await connectSession(inMemory(served));
        await expect(remote.prompt('go', { output: { schema: { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } } } }).result).rejects.toThrow(/JSON Schema/);
        const result = await remote.prompt('go', { output: { schema: { type: 'object' } } }).result;
        expect(result.output).toEqual({ ok: true });
        remote.disconnect();
    });

    it('a cursor the buffer no longer holds: gap without a store, replay through an EventLogStore with one', async () => {
        const evicting = async (eventLog?: ReturnType<typeof memoryEventLog>) => {
            const agent = mockAgent({ script: [[{ text: 'one two three four five' }]] });
            const real = await agent.session();
            let evictOnce = true;
            // Pretend the in-memory buffer has moved past every cursor except live.
            const session: AgentSession = {
                ...real,
                get ref() {
                    return real.ref;
                },
                subscribe: (from?: Cursor) => {
                    if (from && from.epoch > 0 && evictOnce) {
                        evictOnce = false;
                        throw new AgentError('protocol_error', 'evicted');
                    }
                    return real.subscribe(from);
                }
            };
            const served = serveSession(session, { agentId: agent.id, capabilities: agent.capabilities, ...(eventLog ? { eventLog } : {}) });
            await real.prompt('a').result;
            await tick(5);
            return { served, real };
        };
        const noStore = await evicting();
        const frames = await collect(noStore.served.events({ epoch: 1, seq: 2 }, { signal: AbortSignal.timeout(30) }));
        expect(frames.map((f) => f.kind)).toEqual(['hello', 'gap']);
        expect(frames[1]).toMatchObject({ kind: 'gap', from: { epoch: 1, seq: 2 }, resumeAt: noStore.served.head });

        const log = memoryEventLog();
        const stored = await evicting(log);
        expect(log.size).toBeGreaterThan(0);
        const replayed = await collect(stored.served.events({ epoch: 1, seq: 2 }, { signal: AbortSignal.timeout(30) }));
        const eventFrames = replayed.filter((f): f is Extract<WireFrame, { kind: 'event' }> => f.kind === 'event');
        expect(eventFrames[0]!.seq).toBe(3);
        expect(eventFrames.map((f) => f.seq)).toEqual(eventFrames.map((_, i) => i + 3));
        expect(eventFrames.at(-1)!.seq).toBe(stored.served.head.seq);
    });

    it('a serverStream-shaped transport: a POST-style command function and a generator of frames', async () => {
        const { served } = await serve([[{ text: 'via stream' }]]);
        // What `serverFn` / `serverStream` stubs look like from the client: JSON in, JSON out.
        const agentCommand = async (input: { sessionId: string; command: WireCommand }) => JSON.parse(JSON.stringify(await served.handleCommand(JSON.parse(JSON.stringify(input.command)) as WireCommand)));
        const agentEvents = async function* (input: { sessionId: string; from?: Cursor }) {
            for await (const frame of served.events(input.from)) yield JSON.parse(JSON.stringify(frame)) as WireFrame;
        };
        const remote = await connectSession({ send: (command) => agentCommand({ sessionId: served.sessionId, command }), events: (from) => agentEvents({ sessionId: served.sessionId, from }) });
        const { events, result } = await drain(remote.prompt('go'));
        expect(textOf(events)).toBe('via stream');
        expect(result.stopReason).toBe('end_turn');
        const t = createTranscript(remote.id);
        for (const e of events) reduceAgentEvent(t, e);
        expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
        remote.disconnect();
    });
});

/** Yields until `ms` pass without an item — for live subscriptions that never end on their own. */
function until<T>(it: AsyncIterable<T>, ms: number): AsyncIterable<T> {
    return {
        async *[Symbol.asyncIterator]() {
            const iterator = it[Symbol.asyncIterator]();
            try {
                for (;;) {
                    const next = await Promise.race([iterator.next(), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
                    if (next === 'timeout' || next.done) return;
                    yield next.value;
                }
            } finally {
                void iterator.return?.();
            }
        }
    };
}
