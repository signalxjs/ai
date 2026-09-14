// @vitest-environment node
/**
 * Live smokes, one per preset — gated on the executable being resolvable AND
 * an env flag, so CI and machines without the agent skip with a reason.
 */
import { describe, it, expect } from 'vitest';
import { resolveExecutable } from '@sigx/ai-agent-node';
import { acp, gemini, cursor, claudeCodeAcp, codexAcp, type AcpPreset } from '@sigx/ai-agent-acp';

const presets: { name: string; flag: string; preset: AcpPreset }[] = [
    { name: 'gemini', flag: 'SIGX_LIVE_ACP_GEMINI', preset: gemini() },
    { name: 'cursor', flag: 'SIGX_LIVE_ACP_CURSOR', preset: cursor() },
    { name: 'claude-agent-acp', flag: 'SIGX_LIVE_ACP_CLAUDE_CODE', preset: claudeCodeAcp() },
    { name: 'codex-acp', flag: 'SIGX_LIVE_ACP_CODEX', preset: codexAcp() }
];

for (const { name, flag, preset } of presets) {
    const enabled = process.env[flag] === '1';
    const resolvable = await resolveExecutable(preset.command!).then(
        () => true,
        () => false
    );
    const reason = !enabled ? `${flag}=1 not set` : !resolvable ? `"${preset.command}" is not on PATH` : '';
    if (reason) console.log(`[live] skipping ${name}: ${reason}`);
    describe.skipIf(!!reason)(`live: ${name}`, () => {
        it('opens a session and streams one short answer', async () => {
            const agent = acp(preset);
            try {
                const caps = await agent.connect();
                expect(caps.cancel).toBe(true);
                const session = await agent.session({ cwd: process.cwd(), interactive: false });
                let text = '';
                const turn = session.prompt('Reply with the single word: pong');
                for await (const e of turn) if (e.type === 'part-delta') text += e.delta;
                const result = await turn.result;
                expect(['end_turn', 'max_tokens']).toContain(result.stopReason);
                expect(text.toLowerCase()).toContain('pong');
                await session.close();
            } finally {
                await agent.dispose();
            }
        }, 120_000);
    });
}
