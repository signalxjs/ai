/**
 * `node smoke.mjs` — start the example's server and run ONE mock turn.
 *
 * Cross-platform by construction: no shell, no port, no browser. It boots the
 * same Vite dev server `dev-server.mjs` does (so the SSR document and the
 * whole server module graph really load), then drives the real endpoints
 * in-process through `connectSession` — the exact path the browser takes,
 * minus HTTP. A second client joins late and must reach the same transcript.
 *
 * Exits 0 on success, 1 with a reason otherwise.
 */
import { createServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { createDevRequestHandler } from '@sigx/vite/ssr';
import { createTestServerFnContext } from '@sigx/server/testing';
import { connectSession } from '@sigx/ai-agent/wire';
import { createTranscript, reduceAgentEvent } from '@sigx/ai-agent';

const FROM = { epoch: 0, seq: 0 };

function assert(ok, what) {
    if (!ok) throw new Error(`smoke: ${what}`);
    console.log(`  ok  ${what}`);
}

/** Fold a client's events into a transcript until `stop()` says so. */
function follow(session) {
    const transcript = createTranscript(session.id);
    const iterator = session.subscribe(FROM)[Symbol.asyncIterator]();
    const done = (async () => {
        for (;;) {
            const next = await iterator.next();
            if (next.done) return;
            reduceAgentEvent(transcript, next.value);
        }
    })();
    done.catch(() => {});
    return { transcript, stop: () => void iterator.return?.() };
}

const text = (transcript) =>
    transcript.messages
        .flatMap((m) => m.parts)
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');

const tools = (transcript) => transcript.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool');

const reasoning = (transcript) => transcript.messages.flatMap((m) => m.parts).filter((p) => p.type === 'reasoning');

async function until(predicate, what, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        // Awaited: a predicate that has to ask the server is a promise, and
        // an unawaited one is always truthy — it would pass instantly.
        if (await predicate()) return;
        if (Date.now() > deadline) throw new Error(`smoke: timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

const vite = await createViteServer({ root: import.meta.dirname, server: { middlewareMode: true }, appType: 'custom' });
const document = await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' });
const http = createServer((req, res) => {
    vite.middlewares(req, res, () => {
        document(req, res).catch((error) => {
            console.error(error);
            if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(String(error?.stack ?? error));
        });
    });
});

let code = 0;
try {
    await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
    const port = http.address().port;
    console.log(`smoke: server on http://127.0.0.1:${port}`);

    // 1. The document renders (the whole client module graph compiles).
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert(html.includes('id="app"'), 'the SSR document renders');

    // 2. The real endpoints, as the browser's stubs would call them.
    const { agentCatalog, agentCommand, agentEvents, agentOpenSession, agentSessions } = await vite.ssrLoadModule('/src/agent.server.ts');
    const context = createTestServerFnContext();
    const call = (fn) => fn.with({ context });
    // `sessionId` rides the transport envelope, not the wire command.
    const transportFor = (sessionId) => ({
        send: (command) => call(agentCommand)({ sessionId, command }),
        events: (from) => (from ? call(agentEvents)({ sessionId, from }) : call(agentEvents)({ sessionId }))
    });

    // Importing the server module must open NOTHING. This is the regression
    // test for the top-level `await openSession()` this example used to have:
    // it spawned a harness child just by being imported, which is why the DOM
    // test had to mock the whole module.
    assert((await call(agentSessions)({})).length === 0, 'importing the endpoints opens no session');

    const catalog = await call(agentCatalog)({});
    assert(catalog.agents.some((a) => a.id === 'sigx') && catalog.agents.some((a) => a.id === 'mock'), 'the catalogue offers the key-less agents');
    assert(
        catalog.agents.filter((a) => a.kind === 'harness').every((a) => typeof a.install === 'string'),
        'every harness carries an install hint'
    );

    // 3. Open one on our own engine.
    const opened = await call(agentOpenSession)({ agent: 'sigx' });
    assert(opened.ok, `the sigx session opened (${opened.ok ? '' : opened.reason})`);
    const transport = transportFor(opened.session.sessionId);

    const client = await connectSession(transport, { from: FROM });
    assert(typeof client.id === 'string' && client.id.length > 0, 'connectSession got a hello with a session id');
    assert(client.capabilities.permissions === 'every-call', 'the hello carries the agent capabilities');
    const first = follow(client);

    // 4. One turn: a read-only sub-agent and its read-only tool run unasked, a destructive tool asks.
    const turn = client.prompt('Any incidents?');
    await until(() => Object.values(first.transcript.requests).length > 0, 'the destructive tool to ask for permission');
    const request = Object.values(first.transcript.requests)[0];
    assert(request.toolName === 'restart_service', 'the read-only calls ran unasked; the destructive one asked');
    await client.respond(request.requestId, { type: 'permission', outcome: 'allow', scope: 'session' });

    const result = await turn.result;
    assert(result.stopReason === 'end_turn', `the turn ended (${result.stopReason})`);
    // Three tool calls: the host's `triage` and `restart_service`, and the sub-agent's own `list_incidents`.
    // Wait for all three to SETTLE, not merely to exist: the sub-agent's report
    // is text that arrives before `restart_service` finishes, so "some text"
    // no longer means the follower has caught up with the end of the turn.
    const settled = (t) => t.status !== 'pending' && t.status !== 'in_progress';
    const describe = (transcript) =>
        tools(transcript)
            .map((t) => `${t.name}#${t.callId}=${t.status}`)
            .join(', ');
    await until(() => tools(first.transcript).length === 3 && tools(first.transcript).every(settled), 'the transcript to catch up').catch((error) => {
        throw new Error(`${error.message} (${describe(first.transcript)})`);
    });
    const statuses = describe(first.transcript);
    assert(
        tools(first.transcript).every((t) => t.status === 'completed'),
        `every tool call completed, the sub-agent one included (${statuses})`
    );
    assert(/checkout/i.test(text(first.transcript)), 'the agent answered');

    // The sub-agent: an `agent-start` bound to the call that spawned it, its
    // work nested under that call, and one terminal `agent-update`.
    const agents = Object.values(first.transcript.agents);
    const spawn = tools(first.transcript).find((t) => t.name === 'triage');
    assert(agents.length === 1 && spawn !== undefined && agents[0].callId === spawn.callId && spawn.agentId === agents[0].agentId, 'the sub-agent started bound to the tool call that spawned it');
    assert(agents[0].status === 'completed' && agents[0].depth === 0, 'the sub-agent ended completed');
    const nested = first.transcript.messages.filter((m) => m.parentCallId === spawn.callId).flatMap((m) => m.parts);
    assert(
        nested.some((p) => p.type === 'tool' && p.name === 'list_incidents') && nested.some((p) => p.type === 'text' && /INC-41/.test(p.text)),
        'the sub-agent tool call and its report are nested under the spawning call'
    );
    // The exposed-reasoning shape: text, and `done` once `part-end` arrived —
    // which is how the view tells "still thinking" from "thought nothing".
    const thoughts = reasoning(first.transcript);
    assert(thoughts.length === 1 && thoughts[0].text.length > 0 && thoughts[0].done === true, 'the reasoning part carries its text and is marked done');
    assert(first.transcript.grants.includes('tool:restart_service'), 'the session grant was recorded');

    // 5. A LATE JOINER — the second tab — replays to the same transcript.
    const late = await connectSession(transport, { from: FROM });
    const second = follow(late);
    await until(() => tools(second.transcript).length === 3 && second.transcript.state === first.transcript.state, 'the late joiner to replay the turn');
    assert(text(second.transcript) === text(first.transcript), 'the late joiner reached the same transcript');
    assert(second.transcript.state === first.transcript.state, 'the late joiner reached the same state');
    const agentsOf = (transcript) => JSON.stringify(Object.values(transcript.agents).map((a) => [a.agentId, a.callId, a.status, a.depth]));
    assert(agentsOf(second.transcript) === agentsOf(first.transcript), 'the late joiner reached the same sub-agents');

    // 6. A SECOND SESSION, on a different agent. The two must not touch:
    //    this is the one thing that can silently regress once two
    //    `serveSession`s share a process.
    const before = text(first.transcript);
    const other = await call(agentOpenSession)({ agent: 'mock' });
    assert(other.ok, `the mock session opened (${other.ok ? '' : other.reason})`);
    assert(other.session.sessionId !== opened.session.sessionId, 'the second session has its own id');
    const mock = await connectSession(transportFor(other.session.sessionId), { from: FROM });
    const third = follow(mock);
    assert(mock.agentId !== client.agentId, `the two sessions run different agents (${client.agentId} / ${mock.agentId})`);

    await mock.prompt('Any incidents?').result;
    await until(() => /INC-41/.test(text(third.transcript)), 'the mock session to answer');
    assert(text(first.transcript) === before, 'the first session is untouched by the second');
    assert(tools(third.transcript).length > 0 && tools(first.transcript).length === 3, 'each session kept its own tool calls');
    assert((await call(agentSessions)({})).length === 2, 'both sessions are listed');

    // 7. `configure()` over the real endpoint: the mock announces its settings
    //    on its first turn, like a harness does, so by now there are some.
    const modeOption = third.transcript.config.find((o) => o.id === 'mode');
    assert(modeOption !== undefined, `the mock advertised its settings (${JSON.stringify(third.transcript.config)})`);
    await mock.configure({ mode: 'plan' });
    await until(() => third.transcript.config.find((o) => o.id === 'mode')?.current === 'plan', 'the config event to report the switch');
    assert(
        third.transcript.config.some((o) => o.id === 'model'),
        'switching one setting did not drop the others'
    );

    // 8. An unknown session is a typed wire error, not a throw.
    const stale = await call(agentCommand)({ sessionId: 'sess-nope', command: { v: 1, kind: 'command', commandId: 'c1', type: 'cancel' } });
    assert(stale.kind === 'error' && stale.code === 'closed', `a stale session id answers with a wire error (${JSON.stringify(stale)})`);

    // 9. Closing is the wire's own command, and the registry reaps it.
    await mock.close();
    await until(async () => (await call(agentSessions)({})).length === 1, 'the closed session to leave the registry');
    assert((await call(agentSessions)({}))[0].sessionId === opened.session.sessionId, 'the other session is still running');

    first.stop();
    second.stop();
    third.stop();
    client.disconnect();
    late.disconnect();
    mock.disconnect();
    console.log('smoke: passed');
} catch (error) {
    console.error(`\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    code = 1;
} finally {
    // Close every session and dispose every agent before the server goes: a
    // harness child must never outlive the run that spawned it.
    await vite.ssrLoadModule('/src/registry.server.ts').then((m) => m.closeAll()).catch(() => {});
    await new Promise((resolve) => http.close(resolve));
    await vite.close();
}

process.exit(code);
