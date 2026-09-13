/**
 * `useAgentSession` — the reactive transcript. Mounted in a real app (the
 * `sigx` umbrella is fine in tests), driven by `mockAgent`: the same path a
 * browser takes, over a local session and over the wire.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { component, jsx, defineApp } from 'sigx';
import { effect } from '@sigx/reactivity';
import { useAgentSession, type AgentSessionSource, type AgentSessionView, type UseAgentSessionOptions } from '@sigx/ai-agent/app';
import { type AgentSession, type SessionOptions } from '@sigx/ai-agent';
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

async function openSession(script: readonly (readonly MockStep[])[], options: SessionOptions = {}): Promise<AgentSession> {
    const agent = mockAgent({ script: script as MockStep[][] });
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
        const session = await openSession([[{ text: 'slow', delayMs: 30 }]]);
        const m = mount(session);
        await tick();

        const first = m.view.prompt('one');
        await tick(1);
        // A second prompt while the first runs: the mock has no `steer` capability.
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
});
