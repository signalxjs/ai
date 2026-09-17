/**
 * Pure mapping between the contract and the SDK: session options → session
 * config, the advertised `config` options, Copilot's error and tool outcomes
 * → the contract's codes. No I/O here.
 */

import type { CopilotClientOptions, CustomAgentConfig, ModelInfo, SessionConfigBase } from '@github/copilot-sdk';
import type { AgentDefinition, AgentErrorCode, ConfigOption, ConfigValue, ToolStatus } from '@sigx/ai-agent';
import type { CopilotCliOptions, CopilotCliSessionOptions, ReasoningEffort } from './options.js';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The `CopilotClientOptions` for ours, minus the connection (the provider
 * builds that from the SDK). A `gitHubToken` turns the stored login OFF
 * unless `useLoggedInUser` says otherwise — the option's contract, spelled
 * out rather than left to the SDK's own defaulting.
 */
export function toClientOptions(options: CopilotCliOptions): Omit<CopilotClientOptions, 'connection'> {
    const useLoggedInUser = options.useLoggedInUser ?? (options.gitHubToken !== undefined ? false : undefined);
    return {
        ...(options.env ? { env: { ...options.env } } : {}),
        ...(options.cwd !== undefined ? { workingDirectory: options.cwd } : {}),
        ...(options.baseDirectory !== undefined ? { baseDirectory: options.baseDirectory } : {}),
        ...(options.logLevel !== undefined ? { logLevel: options.logLevel } : {}),
        ...(options.gitHubToken !== undefined ? { gitHubToken: options.gitHubToken } : {}),
        ...(useLoggedInUser !== undefined ? { useLoggedInUser } : {}),
        clientInfo: { integrationName: '@sigx/ai-agent-copilot-cli', applicationVersion: '0.1.0' }
    };
}

/** The `SessionConfigBase` fields that come straight from the session options — the callbacks and tools are added by the session. */
export function toSessionConfig(options: CopilotCliSessionOptions): SessionConfigBase {
    return {
        workingDirectory: options.cwd,
        ...(options.additionalDirectories?.length ? { additionalDirectories: [...options.additionalDirectories] } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.system !== undefined ? { systemMessage: { mode: 'append', content: options.system } } : {}),
        ...(options.availableTools !== undefined ? { availableTools: Array.isArray(options.availableTools) ? [...options.availableTools] : options.availableTools } : {}),
        ...(options.excludedTools !== undefined ? { excludedTools: Array.isArray(options.excludedTools) ? [...options.excludedTools] : options.excludedTools } : {}),
        ...(options.mcpServers !== undefined ? { mcpServers: options.mcpServers } : {}),
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.agents ? { customAgents: toCustomAgents(options.agents) } : {}),
        streaming: options.streaming ?? true
    } as SessionConfigBase;
}

/** `SessionOptions.agents` as Copilot custom agents (`defineAgents: true`). */
export function toCustomAgents(agents: Readonly<Record<string, AgentDefinition>>): CustomAgentConfig[] {
    return Object.entries(agents).map(([name, a]) => ({
        name,
        description: a.description,
        prompt: a.prompt ?? a.description,
        ...(a.tools ? { tools: [...a.tools] } : {}),
        ...(a.model !== undefined ? { model: a.model } : {})
    }));
}

/** The models to offer: the runtime's enabled ones, as config values. */
export function toModelValues(models: readonly ModelInfo[]): ConfigValue[] {
    return models.filter((m) => !m.policy || m.policy.state === 'enabled').map((m) => ({ id: m.id, ...(m.name && m.name !== m.id ? { label: m.name } : {}) }));
}

/** What a session advertises: the model it is on and the effort, once known. */
export interface ConfigState {
    model?: string;
    reasoningEffort?: string;
}

/**
 * The `config` options for a state. The session's CURRENT model is always
 * offered, whether or not the list names it — `ConfigOption.current` has to
 * be one of `values` for a client to render it as the selected entry. The
 * effort option lists what the current model supports (`ModelInfo`), or the
 * five efforts when the runtime did not say.
 */
export function configOptions(state: ConfigState, models: readonly ConfigValue[], infos: readonly ModelInfo[] = []): ConfigOption[] {
    if (state.model === undefined) return [];
    const model = state.model;
    const values = models.some((m) => m.id === model) ? [...models] : [{ id: model }, ...models];
    const out: ConfigOption[] = [{ id: 'model', label: 'Model', values, current: model }];
    const info = infos.find((m) => m.id === model);
    const efforts = info?.supportedReasoningEfforts ?? (info?.capabilities.supports.reasoningEffort === false ? [] : REASONING_EFFORTS);
    const effort = state.reasoningEffort ?? info?.defaultReasoningEffort;
    if (effort !== undefined && efforts.length) {
        const listed = efforts.includes(effort as ReasoningEffort) ? [...efforts] : [effort, ...efforts];
        out.push({ id: 'reasoningEffort', label: 'Reasoning effort', values: listed.map((id) => ({ id })), current: effort });
    }
    return out;
}

/** A `session.error` onto the contract's codes. */
export function toErrorCode(error: { readonly errorType?: string; readonly errorCode?: string; readonly statusCode?: number; readonly message?: string }): AgentErrorCode {
    const status = error.statusCode;
    if (status === 401 || status === 403) return 'auth_required';
    if (status === 429) return 'rate_limited';
    const text = `${error.errorType ?? ''} ${error.errorCode ?? ''} ${error.message ?? ''}`.toLowerCase();
    if (/unauthori[sz]ed|authenticat|not logged in|login required/.test(text)) return 'auth_required';
    if (/rate.?limit|quota|too many requests|overloaded|premium request/.test(text)) return 'rate_limited';
    if (/context.?(window|length)|too long|token limit|maximum context/.test(text)) return 'context_exceeded';
    return 'provider_error';
}

/** A `tool.execution_complete` onto a tool status (a denial is recorded by the permission handler before the event arrives). */
export function toToolStatus(complete: { readonly success: boolean }, denied: boolean): ToolStatus {
    if (denied) return 'denied';
    return complete.success ? 'completed' : 'failed';
}
