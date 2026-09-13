import { describe, it, expect } from 'vitest';
import {
    createTranscript,
    reduceAgentEvent,
    spawnedAgent,
    callerAgent,
    childAgents,
    agentMessages,
    agentTree,
    walkAgents,
    agentsUsage,
    type AgentEvent,
    type UnstampedEvent,
    type AgentTranscript
} from '@sigx/ai-agent';

let seq = 0;
const ev = (payload: UnstampedEvent): AgentEvent => ({ ...payload, sessionId: 's', epoch: 1, seq: ++seq });

function reduceAll(events: readonly AgentEvent[]): AgentTranscript {
    const t = createTranscript('s');
    for (const e of events) reduceAgentEvent(t, e);
    return t;
}

/**
 * A turn that spawns `a1` (call c1), which itself spawns `a2` (call c2 made
 * inside c1), plus a call-less ambient agent `obs` and a sibling `a3` (c3).
 */
function tree(): AgentTranscript {
    seq = 0;
    return reduceAll([
        ev({ type: 'turn-start', turnId: 't1', input: [] }),
        ev({ type: 'tool-call', turnId: 't1', callId: 'c1', name: 'delegate', input: { task: 'research' } }),
        ev({ type: 'agent-start', turnId: 't1', parentCallId: 'c1', agentId: 'a1', callId: 'c1', kind: 'researcher', title: 'Research' }),
        ev({ type: 'part-start', turnId: 't1', parentCallId: 'c1', messageId: 'm1', partId: 'p1', kind: 'text', actor: 'researcher' }),
        ev({ type: 'part-delta', turnId: 't1', parentCallId: 'c1', partId: 'p1', delta: 'digging' }),
        ev({ type: 'tool-call', turnId: 't1', parentCallId: 'c1', callId: 'c2', name: 'delegate', input: { task: 'verify' } }),
        ev({ type: 'agent-start', turnId: 't1', parentCallId: 'c2', agentId: 'a2', callId: 'c2', kind: 'verifier' }),
        ev({ type: 'part-start', turnId: 't1', parentCallId: 'c2', messageId: 'm2', partId: 'p2', kind: 'text' }),
        ev({ type: 'part-delta', turnId: 't1', parentCallId: 'c2', partId: 'p2', delta: 'checked' }),
        ev({ type: 'agent-update', turnId: 't1', parentCallId: 'c2', agentId: 'a2', status: 'completed', usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.01, output: 'ok' }),
        ev({ type: 'tool-update', turnId: 't1', parentCallId: 'c1', callId: 'c2', status: 'completed', output: 'ok' }),
        ev({ type: 'agent-update', turnId: 't1', parentCallId: 'c1', agentId: 'a1', status: 'completed', usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.1 }),
        ev({ type: 'tool-update', turnId: 't1', callId: 'c1', status: 'completed', output: 'done' }),
        ev({ type: 'agent-start', turnId: 't1', agentId: 'obs', kind: 'observer', depth: 3 }),
        ev({ type: 'agent-update', turnId: 't1', agentId: 'obs', status: 'running', summary: 'watching' }),
        ev({ type: 'tool-call', turnId: 't1', callId: 'c3', name: 'delegate' }),
        ev({ type: 'agent-start', turnId: 't1', parentCallId: 'c3', agentId: 'a3', callId: 'c3', background: true }),
        ev({ type: 'agent-update', turnId: 't1', parentCallId: 'c3', agentId: 'a3', status: 'cancelled' }),
        ev({ type: 'tool-update', turnId: 't1', callId: 'c3', status: 'cancelled' }),
        ev({ type: 'agent-update', turnId: 't1', agentId: 'obs', status: 'completed' }),
        ev({ type: 'turn-end', turnId: 't1', stopReason: 'end_turn' })
    ]);
}

describe('agent selectors', () => {
    it('spawnedAgent and callerAgent link calls and agents both ways', () => {
        const t = tree();
        expect(spawnedAgent(t, 'c1')?.agentId).toBe('a1');
        expect(spawnedAgent(t, 'c2')?.agentId).toBe('a2');
        expect(spawnedAgent(t, 'nope')).toBeUndefined();
        // c1 was made by the session itself; c2 was made inside a1.
        expect(callerAgent(t, 'c1')).toBeUndefined();
        expect(callerAgent(t, 'c2')?.agentId).toBe('a1');
        expect(callerAgent(t, 'nope')).toBeUndefined();
    });

    it('childAgents lists direct children in start order; a call-less agent is a root', () => {
        const t = tree();
        expect(childAgents(t).map((a) => a.agentId)).toEqual(['a1', 'obs', 'a3']);
        expect(childAgents(t, 'a1').map((a) => a.agentId)).toEqual(['a2']);
        expect(childAgents(t, 'a2')).toEqual([]);
        expect(childAgents(t, 'obs')).toEqual([]);
        // The harness said depth 3 for the ambient agent; with no call to derive from, its word stands.
        expect(t.agents.obs).toMatchObject({ depth: 3, kind: 'observer', status: 'completed', summary: 'watching' });
        expect(t.agents.obs).not.toHaveProperty('callId');
        expect(t.agents.obs).not.toHaveProperty('parentAgentId');
    });

    it('agentMessages returns the messages produced inside the agent', () => {
        const t = tree();
        expect(agentMessages(t, 'a1').map((m) => m.id)).toEqual(['m1']);
        expect(agentMessages(t, 'a2').map((m) => m.id)).toEqual(['m2']);
        expect(agentMessages(t, 'obs')).toEqual([]);
        expect(agentMessages(t, 'nope')).toEqual([]);
    });

    it('agentTree nests by parent and walkAgents visits depth-first in start order', () => {
        const t = tree();
        const nodes = agentTree(t);
        expect(nodes.map((n) => n.agent.agentId)).toEqual(['a1', 'obs', 'a3']);
        expect(nodes[0]!.children.map((n) => n.agent.agentId)).toEqual(['a2']);
        expect(nodes[0]!.children[0]!.children).toEqual([]);
        const visited: string[] = [];
        walkAgents(t, (agent, depth) => visited.push(`${agent.agentId}@${depth}`));
        expect(visited).toEqual(['a1@0', 'a2@1', 'obs@0', 'a3@0']);
        // The node's agent IS the transcript's entry, not a copy.
        expect(nodes[0]!.agent).toBe(t.agents.a1);
    });

    it('agentsUsage sums every agent and the session totals stay the host’s own', () => {
        const t = tree();
        expect(agentsUsage(t)).toEqual({ usage: { inputTokens: 110, outputTokens: 55 }, costUsd: 0.11 });
        expect(t.usage).toBeUndefined();
        expect(agentsUsage(createTranscript('s'))).toEqual({});
    });
});
