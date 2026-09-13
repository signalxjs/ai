/**
 * Selectors over `transcript.agents` — the sub-agent tree, read-only.
 *
 * The reducer keeps agents flat (`Record<agentId, AgentState>`, each with a
 * `parentAgentId`) because that is what replays and persists; these build the
 * views a UI or a host wants: the agent a call spawned, the agent that made a
 * call, an agent's own messages, and the tree in start order. Pure: they read
 * the transcript and allocate only the arrays they return.
 */

import { addUsage, type Usage } from '@sigx/ai';
import type { AgentMessage, AgentState, AgentTranscript, ToolPartState } from './transcript.js';

export interface AgentNode {
    readonly agent: AgentState;
    readonly children: AgentNode[];
}

/** The message holding a tool part, and the part — `undefined` when the call is unknown. */
export function findToolMessage(t: AgentTranscript, callId: string): { message: AgentMessage; part: ToolPartState } | undefined {
    for (let i = t.messages.length - 1; i >= 0; i--) {
        const message = t.messages[i]!;
        const parts = message.parts;
        for (let j = parts.length - 1; j >= 0; j--) {
            const part = parts[j]!;
            if (part.type === 'tool' && part.callId === callId) return { message, part };
        }
    }
    return undefined;
}

/** The sub-agent the call `callId` spawned, if its `agent-start` arrived. */
export function spawnedAgent(t: AgentTranscript, callId: string): AgentState | undefined {
    for (const id in t.agents) {
        const agent = t.agents[id]!;
        if (agent.callId === callId) return agent;
    }
    return undefined;
}

/** The sub-agent that MADE the call `callId` — `undefined` when the session itself did. */
export function callerAgent(t: AgentTranscript, callId: string): AgentState | undefined {
    const parent = findToolMessage(t, callId)?.message.parentCallId;
    return parent === undefined ? undefined : spawnedAgent(t, parent);
}

/** Direct children of an agent in start order; with no `parentAgentId`, the root agents. */
export function childAgents(t: AgentTranscript, parentAgentId?: string): AgentState[] {
    const out: AgentState[] = [];
    for (const id in t.agents) {
        const agent = t.agents[id]!;
        if (agent.parentAgentId === parentAgentId) out.push(agent);
    }
    return out.sort((a, b) => a.seq - b.seq);
}

/** The messages produced inside the agent (those whose `parentCallId` is its spawning call). */
export function agentMessages(t: AgentTranscript, agentId: string): AgentMessage[] {
    const callId = t.agents[agentId]?.callId;
    if (callId === undefined) return [];
    return t.messages.filter((m) => m.parentCallId === callId);
}

/** The sub-agent tree in start order; every node's `agent` is the transcript's own entry. */
export function agentTree(t: AgentTranscript): AgentNode[] {
    const nodesOf = (parentAgentId: string | undefined): AgentNode[] => childAgents(t, parentAgentId).map((agent) => ({ agent, children: nodesOf(agent.agentId) }));
    return nodesOf(undefined);
}

/** Visit every agent depth-first in start order, with its depth in the tree. */
export function walkAgents(t: AgentTranscript, visit: (agent: AgentState, depth: number) => void): void {
    const walk = (nodes: readonly AgentNode[], depth: number) => {
        for (const node of nodes) {
            visit(node.agent, depth);
            walk(node.children, depth + 1);
        }
    };
    walk(agentTree(t), 0);
}

/** Usage and cost summed over every sub-agent — separate from the session totals, which are the host's own. */
export function agentsUsage(t: AgentTranscript): { usage?: Usage; costUsd?: number } {
    let usage: Usage | undefined;
    let costUsd: number | undefined;
    for (const id in t.agents) {
        const agent = t.agents[id]!;
        if (agent.usage !== undefined) usage = addUsage(usage, agent.usage);
        if (agent.costUsd !== undefined) costUsd = (costUsd ?? 0) + agent.costUsd;
    }
    return { ...(usage !== undefined ? { usage } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
}
