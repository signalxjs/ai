/**
 * Our contract → SDK `query` options and user messages. Pure mapping: no
 * process, no network.
 */

import type { Options, OutputFormat, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { jsonSchemaOf, type JsonSchema, type StandardSchemaV1 } from '@sigx/ai';
import { AgentError, type PromptPart, type ToolAnnotations } from '@sigx/ai-agent';
import { categoryOf } from '@sigx/ai-agent/coding';
import type { OutputSpec } from '@sigx/ai-agent';
import { DEFAULT_ENV_ALLOWLIST, buildChildEnv } from '@sigx/ai-agent-node';
import type { ClaudeCodeOptions, ClaudeCodeSessionOptions } from './options.js';

/** Built-in tools that only read. */
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);

/** Annotations we can vouch for on a built-in tool. */
export function toolAnnotations(name: string): ToolAnnotations | undefined {
    return READ_ONLY.has(name) ? { readOnly: true } : undefined;
}

/** `mcp__<server>__<tool>` → the tool's own name and where it lives. */
export function splitToolName(raw: string, serverName: string): { readonly name: string; readonly source: 'client' | 'native' | 'mcp' } {
    const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(raw);
    if (!m) return { name: raw, source: 'native' };
    return { name: m[2]!, source: m[1] === serverName ? 'client' : 'mcp' };
}

/** The argument that identifies what a call touches — the session-grant key's second half. */
export function primaryArg(input: unknown): string {
    if (typeof input !== 'object' || input === null) return '';
    const r = input as Record<string, unknown>;
    for (const key of ['file_path', 'notebook_path', 'path', 'command', 'url', 'pattern', 'query']) {
        if (typeof r[key] === 'string') return r[key] as string;
    }
    return '';
}

export function categoryFor(name: string): string | undefined {
    return categoryOf(name);
}

/** One prompt → one SDK user message (text and image parts; the rest is not supported yet). */
export function toUserMessage(parts: readonly PromptPart[], parentToolUseId: string | null = null): SDKUserMessage {
    const content: Record<string, unknown>[] = [];
    for (const p of parts) {
        if (p.type === 'text') content.push({ type: 'text', text: p.text });
        else if (p.type === 'image') {
            content.push({ type: 'image', source: p.data !== undefined ? { type: 'base64', media_type: p.mediaType, data: p.data } : { type: 'url', url: p.url ?? '' } });
        } else if (p.type === 'resource') content.push({ type: 'text', text: p.text ?? p.uri });
        else throw new AgentError('protocol_error', `[sigx ai-agent-claude-code] prompt part "${p.type}" is not supported (promptParts: text+image)`);
    }
    return { type: 'user', message: { role: 'user', content: content as never }, parent_tool_use_id: parentToolUseId };
}

/** `prompt(input, { output })` → the SDK's per-query output format. */
export function toOutputFormat(spec: OutputSpec | undefined): OutputFormat | undefined {
    if (!spec) return undefined;
    const schema = spec.schema;
    const json: JsonSchema | undefined = '~standard' in schema ? jsonSchemaOf(schema as StandardSchemaV1) : (schema as JsonSchema);
    if (!json) throw new AgentError('protocol_error', '[sigx ai-agent-claude-code] output.schema has no JSON Schema form; pass a JSON Schema or a Standard Schema with a jsonSchema converter');
    return { type: 'json_schema', schema: json };
}

/** The CLI's environment: the allowlist plus Anthropic's own variables, plus the caller's extras. */
export function childEnv(extra: Readonly<Record<string, string | undefined>> | undefined, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const allow = [...DEFAULT_ENV_ALLOWLIST, 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', ...Object.keys(base).filter((k) => k.startsWith('ANTHROPIC_'))];
    return buildChildEnv({ base, allow, ...(extra ? { extra } : {}) });
}

export interface QueryOptionsInput {
    readonly agent: ClaudeCodeOptions;
    readonly session: ClaudeCodeSessionOptions;
    readonly resumeId?: string;
    readonly fork?: boolean;
    readonly outputFormat?: OutputFormat;
    readonly mcpServers?: Options['mcpServers'];
    readonly canUseTool: NonNullable<Options['canUseTool']>;
    readonly abortController: AbortController;
    readonly stderr: (data: string) => void;
    readonly spawn?: Options['spawnClaudeCodeProcess'];
    readonly pathToClaudeCodeExecutable?: string;
}

export function toQueryOptions(input: QueryOptionsInput): Options {
    const { agent, session } = input;
    const mode = session.permissionMode ?? agent.permissionMode ?? 'default';
    if (mode === 'bypassPermissions' && !agent.allowDangerouslySkipPermissions) {
        throw new AgentError('protocol_error', '[sigx ai-agent-claude-code] permissionMode "bypassPermissions" needs allowDangerouslySkipPermissions: true — every tool would run unasked');
    }
    const system = session.system;
    return {
        cwd: session.cwd,
        ...(session.model !== undefined ? { model: session.model } : {}),
        ...(system !== undefined ? { systemPrompt: session.systemPromptPreset ? { type: 'preset', preset: 'claude_code', append: system } : system } : {}),
        settingSources: [...(session.settingSources ?? agent.settingSources ?? [])],
        permissionMode: mode,
        ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        includePartialMessages: true,
        canUseTool: input.canUseTool,
        abortController: input.abortController,
        stderr: input.stderr,
        env: childEnv(agent.env),
        ...(input.resumeId !== undefined ? { resume: input.resumeId } : {}),
        ...(input.fork ? { forkSession: true } : {}),
        ...(session.maxTurns !== undefined ? { maxTurns: session.maxTurns } : {}),
        ...(session.maxBudgetUsd !== undefined ? { maxBudgetUsd: session.maxBudgetUsd } : {}),
        ...(session.additionalDirectories?.length ? { additionalDirectories: [...session.additionalDirectories] } : {}),
        ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
        ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
        ...(input.spawn ? { spawnClaudeCodeProcess: input.spawn } : {}),
        ...(input.pathToClaudeCodeExecutable !== undefined ? { pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable } : {})
    };
}
