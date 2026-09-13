import { describe, it, expect } from 'vitest';
import { isAgentEvent, capabilities, NO_CAPABILITIES, toPromptParts, partsText, AgentError, SessionBusyError, type AgentEvent, type PromptPart } from '@sigx/ai-agent';
import { jsonRoundTrip, jsonEqual } from '../../src/utils/json';

const base = { sessionId: 's1', epoch: 1, seq: 1 };

describe('protocol', () => {
    it('isAgentEvent accepts stamped events of a known type and rejects the rest', () => {
        expect(isAgentEvent({ ...base, type: 'state', value: 'idle' })).toBe(true);
        expect(isAgentEvent({ ...base, type: 'ext', ns: 'coding', name: 'diff', data: {} })).toBe(true);
        expect(isAgentEvent({ ...base, type: 'agent-start', agentId: 'a1', callId: 'c1' })).toBe(true);
        expect(isAgentEvent({ ...base, type: 'agent-update', agentId: 'a1', status: 'running' })).toBe(true);
        expect(isAgentEvent({ type: 'state', value: 'idle' })).toBe(false);
        expect(isAgentEvent({ ...base, type: 'nope' })).toBe(false);
        expect(isAgentEvent(null)).toBe(false);
    });

    it('every sample event survives JSON', () => {
        const samples: AgentEvent[] = [
            { ...base, type: 'turn-start', turnId: 't1', input: [{ type: 'text', text: 'hi' }] },
            { ...base, type: 'part-start', turnId: 't1', messageId: 'm', partId: 'p', kind: 'text' },
            { ...base, type: 'part-delta', turnId: 't1', partId: 'p', delta: 'héllo 🚀' },
            { ...base, type: 'tool-call', turnId: 't1', callId: 'c', name: 'read', input: { path: 'a' }, annotations: { readOnly: true }, category: 'read' },
            { ...base, type: 'tool-update', turnId: 't1', callId: 'c', status: 'completed', content: [{ type: 'json', value: { ok: true } }] },
            { ...base, type: 'agent-start', turnId: 't1', parentCallId: 'c', agentId: 'a', callId: 'c', kind: 'reviewer', title: 'Review', description: 'Check the diff', model: 'claude-opus-5', depth: 1, background: false },
            { ...base, type: 'agent-update', turnId: 't1', parentCallId: 'c', agentId: 'a', status: 'completed', summary: 'done', usage: { totalTokens: 12 }, costUsd: 0.001, output: { ok: true } },
            { ...base, type: 'agent-update', turnId: 't1', agentId: 'b', status: 'failed', error: { code: 'provider_error', message: 'boom' } },
            { ...base, type: 'request', turnId: 't1', requestId: 'r', kind: 'permission', callId: 'c', toolName: 'read', permissionKey: 'read:a' },
            { ...base, type: 'request-resolved', turnId: 't1', requestId: 'r', outcome: 'allow', scope: 'once', by: 'policy', ruleId: 'allowAll', at: 1 },
            { ...base, type: 'turn-end', turnId: 't1', stopReason: 'end_turn', usage: { inputTokens: 1 }, costUsd: 0.01, output: { a: 1 } },
            { ...base, type: 'error', code: 'rate_limited', message: 'slow down', recoverable: true },
            { ...base, type: 'ext', ns: 'agent', name: 'handoff', data: { to: 'billing' } }
        ];
        for (const e of samples) expect(jsonEqual(jsonRoundTrip(e), e)).toBe(true);
    });

    it('capabilities() layers a patch over NO_CAPABILITIES', () => {
        expect(capabilities()).toEqual(NO_CAPABILITIES);
        expect(capabilities({ cancel: true, tools: 'mcp' })).toMatchObject({ cancel: true, tools: 'mcp', resume: false, permissions: 'none', subagents: 'none', defineAgents: false });
        expect(capabilities({ subagents: 'control', defineAgents: true })).toMatchObject({ subagents: 'control', defineAgents: true });
    });

    it('prompt helpers', () => {
        expect(toPromptParts('hi')).toEqual([{ type: 'text', text: 'hi' }]);
        const parts: PromptPart[] = [{ type: 'text', text: 'a' }, { type: 'image', mediaType: 'image/png', data: 'x' }, { type: 'text', text: 'b' }];
        expect(partsText(parts)).toBe('ab');
    });

    it('error classes carry their code and names', () => {
        const e = new AgentError('auth_required', 'sign in', false, { data: { methods: ['oauth'] } });
        expect(e.name).toBe('AgentError');
        expect(e.code).toBe('auth_required');
        expect(e.data).toEqual({ methods: ['oauth'] });
        const b = new SessionBusyError('s1', 't1');
        expect(b.name).toBe('SessionBusyError');
        expect(b.message).toMatch(/busy/);
    });

    it('jsonRoundTrip normalizes undefined and rejects cycles with the package prefix', () => {
        expect(jsonRoundTrip({ a: undefined, b: 1 })).toEqual({ b: 1 });
        const cyc: Record<string, unknown> = {};
        cyc.self = cyc;
        expect(() => jsonRoundTrip(cyc, 'payload')).toThrow(/\[sigx ai-agent\] payload is not JSON-serializable/);
    });
});
