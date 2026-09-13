/**
 * `useAgentSession` — the reactive transcript. Mounted in a real app (the
 * `sigx` umbrella is fine in tests), driven by `mockAgent`: the same path a
 * browser takes, over a local session and over the wire.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { component, jsx, defineApp } from 'sigx';
import { effect } from '@sigx/reactivity';
import { useAgentSession, type AgentMessage, type AgentPart, type AgentSessionSource, type AgentSessionView, type UseAgentSessionOptions } from '@sigx/ai-agent/app';
import { allowAll, type AgentCapabilities, type AgentSession, type SessionOptions } from '@sigx/ai-agent';
import { serveSession, connectSession, type SessionTransport } from '@sigx/ai-agent/wire';
import { mockAgent, type MockStep } from '@sigx/ai-agent/testing';
import { codingExtension, codingState } from '@sigx/ai-agent/coding';
import { tick } from '../helpers';

const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
});

interface Mounted {
    readonly view: AgentSessionView;
    readonly container: HTMLDivElement;
    unmount(): void;
}

/** Mount a component that renders the whole view, so the DOM proves what the signals do. */
function mount(source: AgentSessionSource, options?: UseAgentSessionOptions): Mounted {
    let view!: AgentSessionView;
    const App = component(
        () => {
            view = useAgentSession(source, options);
            return () => (
                <div>
                    <ul class="msgs">
                        {view.messages.map((m) => (
                            <li class={m.role}>
                                {m.parts.map((p) => (p.type === 'text' ? <span class="t">{p.text}</span> : p.type === 'tool' ? <b class="tool">{`${p.name}:${p.status}`}</b> : null))}
                            </li>
                        ))}
                    </ul>
                    <i class="state">{view.state}</i>
                    <u class="requests">{view.requests.length}</u>
                </div>
            );
        },
        { name: 'App' }
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(jsx(App, {})).mount(container);
    let live = true;
    const unmount = () => {
        if (!live) return;
        live = false;
        app.unmount();
        container.remove();
    };
    closers.push(unmount);
    return {
        get view() {
            return view;
        },
        container,
        unmount
    };
}

async function openSession(script: readonly (readonly MockStep[])[], options: SessionOptions = {}, capabilities: Partial<AgentCapabilities> = {}): Promise<AgentSession> {
    const agent = mockAgent({ script: script as MockStep[][], capabilities });
    const session = await agent.session(options);
    closers.push(() => agent.dispose());
    return session;
}

const inMemory = (served: ReturnType<typeof serveSession>): SessionTransport => ({ send: (c) => served.handleCommand(c), events: (from, o) => served.events(from, o) });

describe('useAgentSession', () => {
    it('folds the session into a reactive transcript and renders it', async () => {
        const session = await openSession([[{ text: 'Hello there friend' }]]);
        const m = mount(session);
        await tick();
        expect(m.view.state).toBe('idle');
        expect(m.view.messages).toEqual([]);
        expect(m.view.live).toBe(true);

        const result = await m.view.prompt('hi');
        await tick();

        expect(result?.stopReason).toBe('end_turn');
        expect(m.view.messages.map((x) => x.role)).toEqual(['user', 'assistant']);
        expect(m.container.querySelector('.assistant .t')?.textContent).toBe('Hello there friend');
        expect(m.container.querySelector('.state')?.textContent).toBe('idle');
        expect(m.view.turn?.stopReason).toBe('end_turn');
        expect(m.view.sessionId).toBe(session.id);
    });

    it('a text delta writes one part — the message list never re-runs', async () => {
        const session = await openSession([[{ text: 'one two three four five', delayMs: 1 }]]);
        const m = mount(session);
        await tick();

        let listRuns = 0;
        effect(() => {
            m.view.messages.length;
            listRuns++;
        });
        const done = m.view.prompt('go');
        // Wait for the assistant part to exist, then watch ONLY its text.
        while (!m.view.messages.some((x) => x.role === 'assistant' && x.parts.length)) await tick(1);
        const part = m.view.messages.find((x) => x.role === 'assistant')!.parts[0]!;
        let textRuns = 0;
        effect(() => {
            if (part.type === 'text') part.text;
            textRuns++;
        });
        await done;
        await tick();

        // 1 initial + 2 pushes (user, assistant) = 3; deltas never bump it.
        expect(listRuns).toBe(3);
        expect(textRuns).toBeGreaterThan(2);
        expect(part.type === 'text' && part.text).toBe('one two three four five');
    });

    it('request → respond: the request opens, the answer resolves it and the turn continues', async () => {
        const session = await openSession([[{ tool: { name: 'deploy', input: { env: 'prod' }, output: { ok: true } } }, { text: 'done' }]]);
        const m = mount(session);
        await tick();

        const done = m.view.prompt('ship it');
        while (m.view.requests.length === 0) await tick(1);

        const request = m.view.requests[0]!;
        expect(request.kind).toBe('permission');
        expect(request.toolName).toBe('deploy');
        expect(m.view.state).toBe('awaiting');
        expect(m.container.querySelector('.requests')?.textContent).toBe('1');
        // The tool part points back at its request, so a card can ask in place.
        const tool = m.view.messages.flatMap((x) => x.parts).find((p) => p.type === 'tool')!;
        expect(tool.type === 'tool' && tool.requestId).toBe(request.requestId);

        await m.view.respond(request.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
        const result = await done;
        await tick();

        expect(result?.stopReason).toBe('end_turn');
        expect(m.view.requests).toEqual([]);
        expect(m.container.querySelector('.requests')?.textContent).toBe('0');
        expect(m.container.querySelector('.tool')?.textContent).toBe('deploy:completed');
    });

    it('a denied request leaves the call denied and the turn still ends', async () => {
        const session = await openSession([[{ tool: { name: 'rm', output: 'gone' } }, { text: 'skipped' }]]);
        const m = mount(session);
        await tick();

        const done = m.view.prompt('clean up');
        while (m.view.requests.length === 0) await tick(1);
        await m.view.respond(m.view.requests[0]!.requestId, { type: 'permission', outcome: 'deny', scope: 'once', message: 'no' });
        await done;
        await tick();

        expect(m.container.querySelector('.tool')?.textContent).toBe('rm:denied');
        expect(m.view.requests).toEqual([]);
    });

    it('cancel() ends the running turn as cancelled', async () => {
        const session = await openSession([[{ text: 'a very long answer indeed', delayMs: 20 }]]);
        const m = mount(session);
        await tick();

        const done = m.view.prompt('talk');
        await tick(5);
        await m.view.cancel();
        const result = await done;
        await tick();

        expect(result?.stopReason).toBe('cancelled');
        expect(m.view.turn?.stopReason).toBe('cancelled');
        expect(m.view.state).toBe('idle');
    });

    it('usage, cost and config land on the view; configure() writes back', async () => {
        const session = await openSession([
            [
                { config: [{ id: 'mode', label: 'Mode', values: [{ id: 'fast' }, { id: 'deep' }], current: 'fast' }] },
                { usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, costUsd: 0.25 },
                { text: 'ok' }
            ]
        ]);
        const m = mount(session);
        await tick();
        await m.view.prompt('hi');
        await tick();

        expect(m.view.usage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
        expect(m.view.costUsd).toBe(0.25);
        expect(m.view.config.map((o) => o.id)).toEqual(['mode']);

        await m.view.configure({ mode: 'deep' });
        await tick();
        expect(m.view.config[0]!.current).toBe('deep');
    });

    it('a late joiner replays the session by sequence and reaches the same transcript', async () => {
        const session = await openSession([[{ text: 'first answer' }], [{ text: 'second answer' }]]);
        const first = mount(session);
        await tick();
        await first.view.prompt('one');
        await tick();

        // A second tab, mounted after the fact, with no state of its own.
        const late = mount(session);
        await tick();
        expect(late.view.messages.map((x) => x.role)).toEqual(['user', 'assistant']);
        expect(late.container.querySelector('.assistant .t')?.textContent).toBe('first answer');

        // …and both follow the next turn.
        await late.view.prompt('two');
        await tick();
        expect(first.view.messages.length).toBe(4);
        expect(late.view.messages.length).toBe(4);
        expect(first.container.querySelectorAll('.assistant .t')[1]?.textContent).toBe('second answer');
    });

    it('from: "live" starts at the next event instead of replaying', async () => {
        const session = await openSession([[{ text: 'first' }], [{ text: 'second' }]]);
        const a = mount(session);
        await tick();
        await a.view.prompt('one');
        await tick();

        const b = mount(session, { from: 'live' });
        await tick();
        expect(b.view.messages).toEqual([]);

        await b.view.prompt('two');
        await tick();
        expect(b.view.messages.map((x) => x.role)).toEqual(['user', 'assistant']);
    });

    it('unmount unsubscribes without closing the session', async () => {
        const session = await openSession([[{ text: 'first' }], [{ text: 'second' }]]);
        const m = mount(session);
        await tick();
        await m.view.prompt('one');
        await tick();
        expect(m.view.live).toBe(true);
        const before = m.view.messages.length;

        m.unmount();
        await tick();
        expect(m.view.live).toBe(false);

        // The session is untouched: another consumer still drives it…
        await session.prompt('two').result;
        await tick();
        // …and the unmounted view folded none of it.
        expect(m.view.messages.length).toBe(before);

        const after = mount(session);
        await tick();
        expect(after.view.messages.length).toBe(4);
    });

    it('a turn that settles after unmount touches nothing — no callback, no write', async () => {
        const session = await openSession([[{ text: 'a slow answer indeed', delayMs: 10 }]]);
        const ends: unknown[] = [];
        const errors: Error[] = [];
        const m = mount(session, { onTurnEnd: (r) => ends.push(r), onError: (e) => errors.push(e) });
        await tick();

        const done = m.view.prompt('go');
        // Navigate away mid-turn: the turn keeps running on the session.
        await tick(5);
        m.unmount();
        const before = m.view.messages.length;

        const result = await done;
        await tick(50);

        // The caller still gets what it awaited…
        expect(result?.stopReason).toBe('end_turn');
        // …but the view is gone: no callback, no folded `turn-end`, no deltas.
        expect(ends).toEqual([]);
        expect(errors).toEqual([]);
        expect(m.view.turn?.stopReason).toBeUndefined();
        expect(m.view.error).toBeUndefined();
        expect(m.view.messages.length).toBe(before);
        expect(m.view.live).toBe(false);

        // A failing action after unmount is just as silent.
        await m.view.configure({ mode: 'deep' });
        expect(errors).toEqual([]);
        expect(m.view.error).toBeUndefined();
    });

    it('subscribes on mount, not during setup — the SSR guard', async () => {
        const session = await openSession([[{ text: 'hi' }]]);
        let subscribes = 0;
        let atSetup = -1;
        const spy: AgentSessionSource = {
            ...session,
            get ref() {
                return session.ref;
            },
            subscribe: (from) => {
                subscribes++;
                return session.subscribe(from);
            }
        };
        const App = component(() => {
            useAgentSession(spy);
            // A server render runs setup and the view function, never the
            // mounted hooks: nothing may have been subscribed by now.
            atSetup = subscribes;
            return () => <div />;
        });
        const container = document.createElement('div');
        document.body.appendChild(container);
        const app = defineApp(jsx(App, {})).mount(container);
        closers.push(() => {
            app.unmount();
            container.remove();
        });
        await tick();

        expect(atSetup).toBe(0);
        expect(subscribes).toBe(1);
    });

    it('a prompt that cannot run lands in error instead of rejecting', async () => {
        const session = await openSession([[{ text: 'slow', delayMs: 30 }]], {}, { steer: false });
        const m = mount(session);
        await tick();

        const first = m.view.prompt('one');
        await tick(1);
        // A second prompt while the first runs: this mock has no `steer` capability.
        const second = await m.view.prompt('two');
        expect(second).toBeUndefined();
        expect(m.view.error?.message).toMatch(/busy/);
        await first;
    });

    it('configure() on an agent without the capability fails into error', async () => {
        const agent = mockAgent({ capabilities: { config: false } });
        const session = await agent.session();
        closers.push(() => agent.dispose());
        const m = mount(session);
        await tick();

        await m.view.configure({ mode: 'deep' });
        expect(m.view.error?.message).toMatch(/configure/);
        expect(m.view.error?.code).toBe('protocol_error');
    });

    it('extension reducers plug in unchanged', async () => {
        const session = await openSession([[{ ext: { ns: 'coding', name: 'diff', data: { path: 'src/a.ts', unifiedDiff: '@@ -1 +1 @@' } } }, { text: 'patched' }]]);
        const m = mount(session, { extensions: [codingExtension()] });
        await tick();
        await m.view.prompt('fix it');
        await tick();

        expect(codingState(m.view.transcript)?.diffs.map((d) => d.path)).toEqual(['src/a.ts']);
    });

    it('a lost connection lands in error and connected; reconnect() picks the turn back up', async () => {
        const agent = mockAgent({ script: [[{ text: 'back from the dead', delayMs: 2 }]] });
        const session = await agent.session();
        const served = serveSession(session, { agentId: agent.id, capabilities: agent.capabilities });
        let down = false;
        const transport: SessionTransport = {
            send: (c) => served.handleCommand(c),
            events: (from, o) =>
                (async function* () {
                    if (down) throw new Error('still down');
                    for await (const f of served.events(from, o)) {
                        yield f;
                        if (f.kind === 'event' && f.event.type === 'user-message' && !from) {
                            down = true;
                            throw new Error('gone');
                        }
                    }
                })()
        };
        const remote = await connectSession(transport, { reconnect: { maxAttempts: 1, backoffMs: () => 1 } });
        closers.push(async () => {
            remote.disconnect();
            await served.close();
            await agent.dispose();
        });
        const ends: unknown[] = [];
        const errors: Error[] = [];
        const m = mount(remote, { onTurnEnd: (r) => ends.push(r), onError: (e) => errors.push(e) });
        await tick();
        expect(m.view.connected).toBe(true);

        const done = m.view.prompt('go');
        while (remote.status !== 'lost') await tick(1);
        await tick();
        expect(m.view.connected).toBe(false);
        expect(m.view.live).toBe(true); // still following: the buffer is open, waiting for a reconnect
        expect(m.view.error).toMatchObject({ code: 'protocol_error', recoverable: true });
        expect(m.view.error?.message).toMatch(/lost/);
        expect(errors).toHaveLength(1);
        expect(ends).toEqual([]);

        down = false;
        m.view.reconnect();
        const result = await done;
        await tick(5);
        expect(result?.stopReason).toBe('end_turn');
        expect(ends).toHaveLength(1);
        expect(m.view.connected).toBe(true);
        expect(m.container.querySelector('.assistant .t')?.textContent).toBe('back from the dead');
    });

    it('a session that closes cleanly ends the subscription without an error', async () => {
        const session = await openSession([[{ text: 'bye' }]]);
        const errors: Error[] = [];
        const m = mount(session, { onError: (e) => errors.push(e) });
        await tick();
        await m.view.prompt('hi');
        expect(m.view.connected).toBe(true);

        await session.close();
        await tick();
        expect(m.view.live).toBe(false);
        expect(m.view.connected).toBe(false);
        expect(m.view.state).toBe('closed');
        expect(m.view.error).toBeUndefined();
        expect(errors).toEqual([]);
    });

    it('a remote session that closes cleanly is a clean end too — no lost-connection error', async () => {
        const agent = mockAgent({ script: [[{ text: 'bye' }]] });
        const session = await agent.session();
        const served = serveSession(session, { agentId: agent.id, capabilities: agent.capabilities });
        const remote = await connectSession(inMemory(served), { reconnect: { backoffMs: () => 1 } });
        closers.push(async () => {
            remote.disconnect();
            await served.close();
            await agent.dispose();
        });
        const errors: Error[] = [];
        const m = mount(remote, { onError: (e) => errors.push(e) });
        await tick();
        await m.view.prompt('hi');

        await session.close();
        await tick(5);
        expect(m.view.state).toBe('closed');
        expect(m.view.live).toBe(false);
        expect(m.view.connected).toBe(false);
        expect(remote.status).toBe('closed');
        expect(m.view.error).toBeUndefined();
        expect(errors).toEqual([]);
    });

    it('drives a remote session from connectSession the same way', async () => {
        const agent = mockAgent({ script: [[{ tool: { name: 'search', output: 'found' } }, { text: 'over the wire' }]] });
        const session = await agent.session();
        const served = serveSession(session, { agentId: agent.id, capabilities: agent.capabilities });
        const remote = await connectSession(inMemory(served), { from: { epoch: 0, seq: 0 } });
        closers.push(async () => {
            remote.disconnect();
            await served.close();
            await agent.dispose();
        });

        const m = mount(remote);
        await tick();
        expect(m.view.capabilities?.permissions).toBe('every-call');

        const done = m.view.prompt('look it up');
        while (m.view.requests.length === 0) await tick(1);
        await m.view.respond(m.view.requests[0]!.requestId, { type: 'permission', outcome: 'allow', scope: 'session' });
        const result = await done;
        await tick(5);

        expect(result?.stopReason).toBe('end_turn');
        expect(m.container.querySelector('.tool')?.textContent).toBe('search:completed');
        expect(m.container.querySelector('.assistant .t')?.textContent).toBe('over the wire');
        // The session grant replayed into the transcript, so a second tab knows it too.
        expect(m.view.transcript.grants).toEqual(['tool:search']);
    });

    // -- A message published mid-fold ---------------------------------------
    //
    // The `mount` above renders every part inside ONE render function, so any
    // later re-run of it repaints the whole list and hides a missed
    // notification. A real app splits the rows into CHILD components, each
    // with its own render effect over one message -- and there a missed
    // notification is permanent. These mount that shape.

    const Part = component<{ part: AgentPart }>((ctx) => {
        return () => {
            const p = ctx.props.part;
            if (p.type === 'text') return <span class="t">{p.text}</span>;
            if (p.type === 'tool') return <b class="tool">{`${p.name}:${p.status}`}</b>;
            return null;
        };
    });

    const Row = component<{ message: AgentMessage }>((ctx) => {
        return () => (
            <div class={`msg ${ctx.props.message.role}`}>
                {ctx.props.message.parts.map((part) => (
                    <Part part={part} />
                ))}
            </div>
        );
    });

    /** `mount`, but the rows and parts are child components -- one render effect each. */
    function mountNested(source: AgentSessionSource, options?: UseAgentSessionOptions): Mounted {
        let view!: AgentSessionView;
        const App = component(
            () => {
                view = useAgentSession(source, options);
                return () => (
                    <div>
                        {view.messages.map((m) => (
                            <Row message={m} />
                        ))}
                        <i class="state">{view.state}</i>
                    </div>
                );
            },
            { name: 'NestedApp' }
        );
        const container = document.createElement('div');
        document.body.appendChild(container);
        const app = defineApp(jsx(App, {})).mount(container);
        let live = true;
        const unmount = () => {
            if (!live) return;
            live = false;
            app.unmount();
            container.remove();
        };
        closers.push(unmount);
        return {
            get view() {
                return view;
            },
            container,
            unmount
        };
    }

    it('renders the first part of a message a child component started observing mid-fold', async () => {
        const session = await openSession([[{ text: 'Yep, I am here.' }]]);
        // The turn is over BEFORE the view exists, so every event replays in
        // one burst and `part-start` pushes the assistant message and its part
        // back to back. Pushing the message re-renders the list synchronously
        // -- the new `Row` reads `parts` while it is still empty -- and the
        // part pushed a line later must still reach it.
        await session.prompt('there?').result;

        const m = mountNested(session);
        await tick();

        expect(m.container.querySelector('.assistant')).not.toBeNull();
        expect(m.container.querySelector('.assistant .t')?.textContent).toBe('Yep, I am here.');
        expect(m.container.querySelector('.user .t')?.textContent).toBe('there?');
    });

    it('renders a tool card on a message a child component started observing mid-fold', async () => {
        const session = await openSession([[{ tool: { name: 'search', output: 'found' } }, { text: 'done' }]], { policy: allowAll });
        await session.prompt('look it up').result;

        const m = mountNested(session);
        await tick();

        expect(m.container.querySelector('.assistant .tool')?.textContent).toBe('search:completed');
    });

    it('keeps rendering deltas that land after a replay, in the same child components', async () => {
        const session = await openSession([[{ text: 'first answer' }], [{ text: 'second answer', delayMs: 1 }]]);
        await session.prompt('one').result;

        const m = mountNested(session);
        await tick();
        expect(m.container.querySelector('.assistant .t')?.textContent).toBe('first answer');

        await m.view.prompt('two');
        await tick();
        expect([...m.container.querySelectorAll('.assistant .t')].map((n) => n.textContent)).toEqual(['first answer', 'second answer']);
    });

    it('replays a completed turn over the wire into child components', async () => {
        const agent = mockAgent({ script: [[{ text: 'Yep, I am here.' }]] });
        const session = await agent.session();
        // `coalesce` is what the example server uses: the whole run of deltas
        // arrives as ONE frame, so the burst is as tight as it gets.
        const served = serveSession(session, { agentId: agent.id, capabilities: agent.capabilities, coalesce: { maxDelayMs: 5 } });
        await session.prompt('there?').result;

        const remote = await connectSession(inMemory(served), { from: { epoch: 0, seq: 0 } });
        closers.push(async () => {
            remote.disconnect();
            await served.close();
            await agent.dispose();
        });

        const m = mountNested(remote);
        while (m.container.querySelector('.assistant') === null) await tick(1);
        await tick(20);

        expect(m.container.querySelector('.assistant .t')?.textContent).toBe('Yep, I am here.');
    });

    it('the coding state the first ext event creates is observable', async () => {
        const session = await openSession([[{ ext: { ns: 'coding', name: 'diff', data: { path: 'src/a.ts', unifiedDiff: '@@ -1 +1 @@' } } }, { text: 'patched' }]]);
        const m = mount(session, { extensions: [codingExtension()] });
        await tick();

        let paths: string[] = [];
        let runs = 0;
        effect(() => {
            paths = codingState(m.view.transcript)?.diffs.map((d) => d.path) ?? [];
            runs++;
        });
        expect(runs).toBe(1);

        await m.view.prompt('fix it');
        await tick();

        // The very first `diff` -- the one that CREATES `ext.coding` -- has to
        // notify too, not just the ones that find it already there.
        expect(paths).toEqual(['src/a.ts']);
        expect(runs).toBeGreaterThan(1);
    });
});

describe('useAgentSession: sub-agents and steering', () => {
    /** A served mock behind `connectSession`, torn down after the test. */
    async function openRemote(script: readonly (readonly MockStep[])[], options: SessionOptions = {}) {
        const agent = mockAgent({ script: script as MockStep[][] });
        const session = await agent.session(options);
        const served = serveSession(session, { agentId: agent.id, capabilities: agent.capabilities });
        const remote = await connectSession(inMemory(served), { from: { epoch: 0, seq: 0 } });
        closers.push(async () => {
            remote.disconnect();
            await served.close();
            await agent.dispose();
        });
        return remote;
    }

    const nested: readonly MockStep[] = [
        { agent: { name: 'reviewer', steps: [{ agent: { name: 'grand', steps: [{ text: 'deep' }], output: 'seen' } }, { text: 'reviewed' }], output: { ok: true } } },
        { text: 'Done.' }
    ];

    it('sub-agents land on agents (start order) and agentTree (nested)', async () => {
        const session = await openSession([nested], { policy: allowAll });
        const m = mount(session);
        await tick();
        expect(m.view.agents).toEqual([]);
        expect(m.view.agentTree).toEqual([]);

        const result = await m.view.prompt('review');
        await tick();
        expect(result?.stopReason).toBe('end_turn');
        expect(m.view.agents.map((a) => [a.title, a.status, a.depth, a.output])).toEqual([
            ['reviewer', 'completed', 0, { ok: true }],
            ['grand', 'completed', 1, 'seen']
        ]);
        // The tree nests the grandchild under the reviewer, and every node is the transcript's own entry.
        expect(m.view.agentTree.map((n) => [n.agent.title, n.children.map((c) => c.agent.title)])).toEqual([['reviewer', ['grand']]]);
        expect(m.view.agentTree[0]!.agent).toBe(m.view.agents[0]);
        // The spawning tool part points at its agent.
        const tool = m.view.messages.flatMap((x) => x.parts).find((p) => p.type === 'tool' && p.name === 'reviewer');
        expect(tool?.type === 'tool' && tool.agentId).toBe(m.view.agents[0]!.agentId);
        expect(tool?.type === 'tool' && tool.callId).toBe(m.view.agents[0]!.callId);
    });

    it('the agent list is reactive: a status change re-runs an effect over it', async () => {
        const session = await openSession([[{ agent: { name: 'helper', steps: [{ text: 'hi' }] } }, { text: 'Done.' }]], { policy: allowAll });
        const m = mount(session);
        await tick();
        const seen: string[] = [];
        effect(() => {
            seen.push(m.view.agents.map((a) => a.status).join(',') || '-');
        });

        await m.view.prompt('go');
        await tick();
        expect(seen[0]).toBe('-');
        expect(seen).toContain('running');
        expect(seen.at(-1)).toBe('completed');
    });

    it('cancelAgent() stops one sub-agent while the turn goes on', async () => {
        const session = await openSession([[{ agent: { name: 'digger', steps: [{ tool: { name: 'slow', delayMs: 60_000 } }, { text: 'never' }] } }, { text: 'Done.' }]], { policy: allowAll });
        const m = mount(session);
        await tick();

        const done = m.view.prompt('dig');
        while (!m.view.messages.flatMap((x) => x.parts).some((p) => p.type === 'tool' && p.name === 'slow' && p.status === 'in_progress')) await tick(1);
        const digger = m.view.agents[0]!;
        expect(digger.status).toBe('running');

        await m.view.cancelAgent(digger.agentId);
        const result = await done;
        await tick();

        expect(result?.stopReason).toBe('end_turn');
        expect(m.view.agents[0]!.status).toBe('cancelled');
        expect(m.view.error).toBeUndefined();
        expect(m.container.querySelector('.assistant .t')?.textContent).toBe('Done.');
    });

    it('cancelAgent() on an agent without sub-agent control fails into error', async () => {
        const session = await openSession([[{ text: 'plain' }]], {}, { subagents: 'none' });
        const m = mount(session);
        await tick();

        await m.view.cancelAgent('agent_1');
        expect(m.view.error?.code).toBe('protocol_error');
        expect(m.view.error?.message).toMatch(/subagents|control/);
    });

    it('prompt() during a turn steers it: same turn, one onTurnEnd, the reply in the transcript', async () => {
        const session = await openSession([[{ tool: { name: 'guarded' } }, { text: 'Done.' }]]);
        const ends: unknown[] = [];
        const m = mount(session, { onTurnEnd: (r) => ends.push(r) });
        await tick();

        const first = m.view.prompt('start');
        while (m.view.requests.length === 0) await tick(1);
        const turnId = m.view.turn?.turnId;

        const second = m.view.prompt('also say hi');
        await tick(2);
        // The steer is in the transcript at once, inside the running turn.
        expect(m.view.messages.filter((x) => x.role === 'user').map((x) => x.turnId)).toEqual([turnId, turnId]);
        expect(m.view.turn?.turnId).toBe(turnId);
        expect(m.view.turn?.stopReason).toBeUndefined();

        await m.view.respond(m.view.requests[0]!.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
        const [a, b] = await Promise.all([first, second]);
        await tick();

        expect(a?.stopReason).toBe('end_turn');
        expect(b).toEqual(a);
        expect(ends).toHaveLength(1);
        expect(m.view.turn?.turnId).toBe(turnId);
        expect(m.view.state).toBe('idle');
        expect(m.view.error).toBeUndefined();
        const texts = [...m.container.querySelectorAll('.assistant .t')].map((n) => n.textContent);
        expect(texts).toContain('Steered.');
        expect(texts).toContain('Done.');
    });

    it('over the wire: agents, cancelAgent and steering behave the same', async () => {
        const remote = await openRemote([[{ agent: { name: 'digger', steps: [{ tool: { name: 'slow', delayMs: 60_000 } }] } }, { tool: { name: 'guarded' } }, { text: 'Done.' }]], { policy: allowAll });
        const ends: unknown[] = [];
        const m = mount(remote, { onTurnEnd: (r) => ends.push(r) });
        await tick();
        expect(m.view.capabilities?.subagents).toBe('control');
        expect(m.view.capabilities?.steer).toBe(true);

        const first = m.view.prompt('dig');
        while (!m.view.messages.flatMap((x) => x.parts).some((p) => p.type === 'tool' && p.name === 'slow' && p.status === 'in_progress')) await tick(1);
        const digger = m.view.agents[0]!;
        expect(m.view.agentTree.map((n) => n.agent.title)).toEqual(['digger']);

        // A steer while the sub-agent still runs; `allowAll` means no request to wait on.
        const second = m.view.prompt('and hurry');
        await tick(2);
        await m.view.cancelAgent(digger.agentId);
        const [a, b] = await Promise.all([first, second]);
        await tick(5);

        expect(a?.stopReason).toBe('end_turn');
        expect(b).toEqual(a);
        expect(ends).toHaveLength(1);
        expect(m.view.agents[0]!.status).toBe('cancelled');
        expect(m.view.messages.filter((x) => x.role === 'user')).toHaveLength(2);
        expect(m.view.error).toBeUndefined();
        expect([...m.container.querySelectorAll('.assistant .t')].map((n) => n.textContent)).toContain('Steered.');
    });

    it('over the wire: cancelAgent against a served session without control fails into error', async () => {
        const agent = mockAgent({ script: [[{ text: 'plain' }]], capabilities: { subagents: 'observe' } });
        const session = await agent.session();
        const served = serveSession(session, { agentId: agent.id, capabilities: agent.capabilities });
        const remote = await connectSession(inMemory(served));
        closers.push(async () => {
            remote.disconnect();
            await served.close();
            await agent.dispose();
        });
        const m = mount(remote);
        await tick();

        await m.view.cancelAgent('agent_1');
        expect(m.view.error?.code).toBe('protocol_error');
        expect(m.view.error?.message).toMatch(/unsupported/);
    });
});
