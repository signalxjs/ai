import { describe, it, expect } from 'vitest';
import { allowAll, type Agent, type AgentEvent, type AgentSession, type AgentTurn } from '@sigx/ai-agent';
import { mockAgent, recordAgent, replayAgent, serializeFixture, ReplayMismatchError, agentConformance, MOCK_CAPABILITIES, type AgentFixture, type ConformanceScenario, type FixtureCommand, type MockStep } from '@sigx/ai-agent/testing';
import { collect } from '../helpers';

/** Strip the stamps so a recorded run and its replay compare on content. */
const payloads = (events: readonly AgentEvent[]) => events.map(({ sessionId: _s, epoch: _e, seq: _q, ...rest }) => rest);

async function driveApproving(session: { prompt(input: string): AgentTurn; respond(id: string, d: { type: 'permission'; outcome: 'allow'; scope: 'once' }): Promise<void> }, prompt: string) {
    const turn = session.prompt(prompt);
    const events: AgentEvent[] = [];
    for await (const e of turn) {
        events.push(e);
        if (e.type === 'request') await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
    }
    return { events, result: await turn.result };
}

describe('recordAgent / replayAgent', () => {
    const script: MockStep[] = [{ reasoning: 'hm', text: 'Hello there' }, { tool: { name: 'rm', input: { path: 'a' }, output: 'gone' } }, { ext: { ns: 'coding', name: 'diff', data: { path: 'a' } } }, { usage: { outputTokens: 2 } }];

    it('records commands interleaved with events and replays them identically', async () => {
        const recorded: AgentFixture[] = [];
        const recorder = recordAgent(mockAgent({ script: [script] }), { onRecord: (f) => recorded.push(f) });
        const live = await recorder.session({ system: 'be brief' });
        const liveRun = await driveApproving(live, 'go');
        await live.close();
        expect(recorded).toHaveLength(1);
        const fixture = recorder.fixture;
        expect(fixture.agent).toEqual({ id: 'mock', capabilities: MOCK_CAPABILITIES });
        expect(fixture.sessions[0]!.options).toEqual({ system: 'be brief' });
        const kinds = fixture.sessions[0]!.log.map((e) => ('command' in e ? `cmd:${e.command.kind}` : e.event.type));
        expect(kinds[0]).toBe('cmd:prompt');
        expect(kinds).toContain('cmd:respond');
        // The close command precedes the `closed` state event the session emits on its way out.
        expect(kinds.filter((k) => k.startsWith('cmd:')).at(-1)).toBe('cmd:close');
        expect(kinds.indexOf('cmd:respond')).toBeGreaterThan(kinds.indexOf('request'));
        expect(kinds.indexOf('cmd:respond')).toBeLessThan(kinds.indexOf('request-resolved'));

        // The fixture survives JSON with a stable key order.
        const json = serializeFixture(fixture);
        expect(json).toBe(serializeFixture(JSON.parse(json) as AgentFixture));
        const replay = replayAgent(JSON.parse(json) as AgentFixture);
        expect(replay.capabilities).toEqual(MOCK_CAPABILITIES);
        const session = await replay.session({ system: 'be brief' });
        expect(session.id).toBe(live.id);
        const replayRun = await driveApproving(session, 'go');
        expect(payloads(replayRun.events)).toEqual(payloads(liveRun.events));
        expect(replayRun.result).toEqual(liveRun.result);
        await session.close();
        await replay.dispose();
    });

    it('records events the session emitted while opening, before the recorder attached', async () => {
        // An agent that announces its config as part of opening the session.
        const inner = mockAgent({ script: [[{ text: 'hi' }]] });
        const announcing: Agent = {
            ...inner,
            async session(options) {
                const session = await inner.session(options);
                await session.configure!({ mode: 'auto' });
                return session;
            }
        };
        const recorder = recordAgent(announcing);
        const session = await recorder.session();
        await session.prompt('go').result;
        await session.close();
        const types = recorder.fixture.sessions[0]!.log.filter((e): e is { event: AgentEvent } => 'event' in e).map((e) => e.event.type);
        expect(types[0]).toBe('config');
        const replayed = await replayAgent(recorder.fixture).session();
        const seen = collect(replayed.subscribe({ epoch: 0, seq: 0 }));
        await replayed.prompt('go').result;
        await replayed.close();
        expect((await seen).map((e) => e.type)).toContain('config');
        // A client that only awaits results still gets its commands after the events they followed.
        const kinds = recorder.fixture.sessions[0]!.log.map((e) => ('command' in e ? 'cmd:' + e.command.kind : e.event.type));
        expect(kinds.indexOf('cmd:prompt')).toBeGreaterThan(kinds.indexOf('config'));
        expect(kinds.at(-1)).toBe('cmd:close');
    });

    it('throws with a diff when the client deviates from the recording', async () => {
        const recorder = recordAgent(mockAgent({ script: [script] }));
        const live = await recorder.session();
        await driveApproving(live, 'go');
        await live.close();
        const fixture = recorder.fixture;

        // A different prompt, or a different caller-supplied turnId.
        const s1 = await replayAgent(fixture).session();
        await expect(s1.prompt('something else').result).rejects.toBeInstanceOf(ReplayMismatchError);
        const s1b = await replayAgent(fixture).session();
        await expect(s1b.prompt('go', { turnId: 'not-the-recorded-one' }).result).rejects.toBeInstanceOf(ReplayMismatchError);

        // A different decision.
        const s2 = await replayAgent(fixture).session();
        const turn = s2.prompt('go');
        let error: unknown;
        for await (const e of turn) {
            if (e.type === 'request') await s2.respond(e.requestId, { type: 'permission', outcome: 'deny', scope: 'once' }).catch((err: unknown) => (error = err));
            if (error) break;
        }
        expect(error).toBeInstanceOf(ReplayMismatchError);
        expect((error as Error).message).toMatch(/expected: .*"allow"/);

        // Closing before the recorded commands are done is a deviation too.
        const s3 = await replayAgent(fixture).session();
        await expect(s3.close()).rejects.toBeInstanceOf(ReplayMismatchError);

        // Different session options.
        await expect(replayAgent(fixture).session({ system: 'other' })).rejects.toBeInstanceOf(ReplayMismatchError);
        await expect(replayAgent(fixture, { checkSessionOptions: false }).session({ system: 'other' })).resolves.toBeDefined();
    });

    it('replays a cancelled turn and a resumed session', async () => {
        const recorder = recordAgent(mockAgent({ script: [[{ tool: { name: 'slow', delayMs: 5000 } }], [{ text: 'after resume' }]] }));
        const live = await recorder.session({ policy: allowAll });
        const turn = live.prompt('go');
        for await (const e of turn) if (e.type === 'tool-update' && e.status === 'in_progress') await live.cancel();
        expect((await turn.result).stopReason).toBe('cancelled');
        const ref = live.ref;
        await live.close();
        const resumed = await recorder.session({ resume: ref, policy: allowAll });
        const second = await collect(resumed.prompt('again'));
        await resumed.close();

        const replay = replayAgent(recorder.fixture);
        const r1 = await replay.session({ policy: allowAll });
        const rt = r1.prompt('go');
        const events: AgentEvent[] = [];
        for await (const e of rt) {
            events.push(e);
            if (e.type === 'tool-update' && e.status === 'in_progress') await r1.cancel();
        }
        expect((await rt.result).stopReason).toBe('cancelled');
        expect(events.find((e) => e.type === 'tool-update' && e.status === 'cancelled')).toBeDefined();
        expect(r1.ref).toEqual(ref);
        await r1.close();
        const r2 = await replay.session({ resume: ref, policy: allowAll });
        const replayed = await collect(r2.prompt('again'));
        expect(payloads(replayed)).toEqual(payloads(second));
        expect(replayed[0]!.epoch).toBe(second[0]!.epoch);
    });

    it('records and replays a targeted cancel and a steer', async () => {
        const script: MockStep[][] = [
            [{ agent: { name: 'slowpoke', steps: [{ tool: { name: 'slow', delayMs: 60_000 } }] } }, { text: 'Carried on.' }],
            [{ tool: { name: 'guarded', output: 1 } }, { text: 'Done.' }]
        ];
        const drive = async (session: AgentSession) => {
            const turn = session.prompt('go');
            const events: AgentEvent[] = [];
            for await (const e of turn) {
                events.push(e);
                if (e.type === 'request') await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
                if (e.type === 'agent-update' && e.status === 'running') await session.cancel({ agentId: e.agentId });
            }
            const second = session.prompt('again');
            let steer: AgentTurn | undefined;
            for await (const e of second) {
                events.push(e);
                if (e.type === 'request') {
                    steer = session.prompt('also thanks');
                    await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
                }
            }
            expect(steer!.id).toBe(second.id);
            return { events, results: [await turn.result, await second.result, await steer!.result] };
        };
        const recorder = recordAgent(mockAgent({ script }));
        const live = await recorder.session();
        const liveRun = await drive(live);
        await live.close();
        const commands = recorder.fixture.sessions[0]!.log.filter((e): e is { command: FixtureCommand } => 'command' in e).map((e) => e.command);
        expect(commands.find((c) => c.kind === 'cancel')).toEqual({ kind: 'cancel', agentId: 'agent_1' });
        expect(commands.filter((c) => c.kind === 'prompt').map((c) => (c as { turnId: string }).turnId)).toEqual([liveRun.results[0]!.turnId, liveRun.results[1]!.turnId, liveRun.results[1]!.turnId]);

        const replay = await replayAgent(JSON.parse(serializeFixture(recorder.fixture)) as AgentFixture).session();
        const replayRun = await drive(replay);
        expect(payloads(replayRun.events)).toEqual(payloads(liveRun.events));
        expect(replayRun.results).toEqual(liveRun.results);
        await replay.close();

        // A steer the recording does not have is a deviation.
        const strayed = await replayAgent(recorder.fixture).session();
        const turn = strayed.prompt('go');
        for await (const e of turn) {
            if (e.type === 'request') await strayed.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
            if (e.type === 'agent-update' && e.status === 'running') {
                await expect(strayed.prompt('unexpected').result).rejects.toBeInstanceOf(ReplayMismatchError);
                await strayed.cancel({ agentId: e.agentId });
            }
        }
        expect((await turn.result).stopReason).toBe('end_turn');
    });

    it('records listSessions results and replays them in order', async () => {
        const recorder = recordAgent(mockAgent({ script: [[{ text: 'hi' }]] }));
        expect(recorder.listSessions).toBeDefined();
        expect(await recorder.listSessions!()).toEqual([]);
        const live = await recorder.session();
        await live.prompt('go').result;
        const listed = await recorder.listSessions!();
        expect(listed).toEqual([{ ref: live.ref }]);
        await live.close();
        expect(recorder.fixture.listSessions).toEqual([[], listed]);

        const replay = replayAgent(JSON.parse(serializeFixture(recorder.fixture)) as AgentFixture);
        expect(replay.listSessions).toBeDefined();
        expect(await replay.listSessions!()).toEqual([]);
        expect(await replay.listSessions!()).toEqual(listed);
        await expect(replay.listSessions!()).rejects.toBeInstanceOf(ReplayMismatchError);

        // An agent without listSessions replays without it.
        const plain = recordAgent(mockAgent({ capabilities: { listSessions: false } }));
        expect(plain.listSessions).toBeUndefined();
        expect(replayAgent(plain.fixture).listSessions).toBeUndefined();
    });

    it('a recorded conformance run replays through the conformance suite', async () => {
        const scripts: Record<string, MockStep[]> = {
            'tool-permission': [{ tool: { name: 'guarded', input: {}, output: { ok: true }, source: 'client' } }, { text: 'Done.' }],
            'input-request': [{ request: { kind: 'input', message: 'Yes or no?' } }, { text: 'Thanks.' }],
            text: [{ text: 'Hello!' }]
        };
        const fixtures = new Map<string, AgentFixture>();
        const record = agentConformance((s: ConformanceScenario) => {
            const r = recordAgent(mockAgent({ script: [scripts[s.name] ?? scripts.text!, scripts.text!] }));
            fixtures.set(s.name, r.fixture);
            return r;
        });
        for (const name of ['text', 'tool-permission', 'input-request']) await record.find((c) => c.name === `conformance: ${name}`)!.run();
        const replay = agentConformance((s) => replayAgent(fixtures.get(s.name)!));
        for (const name of ['text', 'tool-permission', 'input-request']) await replay.find((c) => c.name === `conformance: ${name}`)!.run();
    });
});
