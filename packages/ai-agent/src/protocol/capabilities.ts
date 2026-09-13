/**
 * Capabilities — what an agent really delivers. Clients branch on these,
 * never on `agent.id`; an adapter declares what it can honour, not what the
 * vendor advertises.
 */

export interface AgentCapabilities {
    /** `portable`: the `SessionRef` carries or names the whole transcript; `local`: only on the harness's machine. */
    readonly resume: 'portable' | 'local' | false;
    readonly fork: boolean;
    readonly cancel: boolean;
    /** `prompt()` while a turn runs is accepted as steering input instead of rejecting with `SessionBusyError`. */
    readonly steer: boolean;
    /** `configure()` and `config` events. */
    readonly config: boolean;
    /** `prompt(input, { output })` yields `turn-end.output`. */
    readonly structuredOutput: boolean;
    readonly promptParts: 'text' | 'text+image' | 'text+image+file';
    /** How client tools reach the model: in-process, over MCP, or not at all. */
    readonly tools: 'native' | 'mcp' | 'none';
    /** `every-call`: every tool call reaches the policy; `harness-filtered`: the harness auto-runs some. */
    readonly permissions: 'every-call' | 'harness-filtered' | 'none';
    /** `fromUIMessages` transcripts can seed a session. */
    readonly importTranscript: boolean;
    readonly listSessions: boolean;
    /**
     * `none`: no sub-agent events; `observe`: `agent-start` / `agent-update` plus the
     * sub-agent's events nested under `parentCallId`; `control`: also `cancel({ agentId })`
     * and `respond()` to a request raised at any depth.
     */
    readonly subagents: 'none' | 'observe' | 'control';
    /** `SessionOptions.agents` definitions become spawnable sub-agents. */
    readonly defineAgents: boolean;
}

/** Nothing beyond a text prompt. */
export const NO_CAPABILITIES: AgentCapabilities = {
    resume: false,
    fork: false,
    cancel: false,
    steer: false,
    config: false,
    structuredOutput: false,
    promptParts: 'text',
    tools: 'none',
    permissions: 'none',
    importTranscript: false,
    listSessions: false,
    subagents: 'none',
    defineAgents: false
};

/** `NO_CAPABILITIES` with `patch` applied — the way an adapter states its set. */
export function capabilities(patch: Partial<AgentCapabilities> = {}): AgentCapabilities {
    return { ...NO_CAPABILITIES, ...patch };
}
