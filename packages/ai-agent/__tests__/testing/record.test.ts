import { describe, it, expect } from 'vitest';
import { allowAll, type AgentEvent, type AgentTurn } from '@sigx/ai-agent';
import { mockAgent, recordAgent, replayAgent, serializeFixture, ReplayMismatchError, agentConformance, MOCK_CAPABILITIES, type AgentFixture, type ConformanceScenario, type MockStep } from '@sigx/ai-agent/testing';
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

    it('throws with a diff when the client deviates from the recording', async () => {
        const recorder = recordAgent(mockAgent({ script: [script] }));
        const live = await recorder.session();
        await driveApproving(live, 'go');
        await live.close();
        const fixture = recorder.fixture;

        // A different prompt.
        const s1 = await replayAgent(fixture).session();
        await expect(s1.prompt('something else').result).rejects.toBeInstanceOf(ReplayMismatchError);

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
