/**
 * Our contract → SDK `query` options and user messages. Pure mapping: no
 * process, no network.
 */

import type { AgentDefinition as SdkAgentDefinition, Options, OutputFormat, PermissionMode, SDKUserMessage, ThinkingConfig } from '@anthropic-ai/claude-agent-sdk';
import { jsonSchemaOf, type JsonSchema, type StandardSchemaV1 } from '@sigx/ai';
import { AgentError, type AgentDefinition, type ConfigOption, type ConfigValue, type PromptPart, type ToolAnnotations } from '@sigx/ai-agent';
import { categoryOf } from '@sigx/ai-agent/coding';
import type { OutputSpec } from '@sigx/ai-agent';
import { DEFAULT_ENV_ALLOWLIST, buildChildEnv } from '@sigx/ai-agent-node';
import type { ClaudeCodeOptions, ClaudeCodeSessionOptions } from './options.js';

/** Built-in tools that only read. */
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);

/** Every permission mode the CLI knows — what a `config` event advertises. */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'] as const;

/**
 * The models the `model` config option offers by default.
 *
 * The SDK has no model-listing call (Codex's `model/list` has no counterpart
 * here), so this is a constant, like `PERMISSION_MODES`. It carries both the
 * aliases the CLI resolves for itself and the current full ids — the SDK's own
 * docstring gives the alias vocabulary. `claudeCode({ models })` replaces it
 * for a gateway, for Bedrock / Vertex ids, or for `fable`, which is left out
 * here because it is not generally available.
 *
 * A session's CURRENT model is always offered too, whether or not it is in
 * this list — see `configOptions`.
 */
export const CLAUDE_CODE_MODELS: readonly ConfigValue[] = [
    { id: 'opus', label: 'Opus (latest)', description: 'The alias — Claude Code resolves it to the current Opus.' },
    { id: 'sonnet', label: 'Sonnet (latest)', description: 'The alias — Claude Code resolves it to the current Sonnet.' },
    { id: 'haiku', label: 'Haiku (latest)', description: 'The alias — Claude Code resolves it to the current Haiku.' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }
];

/** How much of Claude's thinking reaches the client — what the `thinkingDisplay` config option advertises. */
export const THINKING_DISPLAYS = ['summarized', 'omitted'] as const;
export type ThinkingDisplay = (typeof THINKING_DISPLAYS)[number];

/**
 * Thinking the way Claude Code shows it itself. The CLI defaults to
 * `omitted`, which leaves every reasoning part empty; `adaptive` is what the
 * SDK already picks for models that support it, and the CLI degrades it to
 * the model's own thinking mode on ones that do not (measured against
 * Sonnet 4.5 and Haiku 4.5: both stream summaries, neither errors).
 */
export const DEFAULT_THINKING: ThinkingConfig = { type: 'adaptive', display: 'summarized' };

/** The `thinking` the query gets: the default unless the caller decided — `null` opts out of sending one at all. */
export function resolveThinking(thinking: ThinkingConfig | null | undefined): ThinkingConfig | undefined {
    if (thinking === null) return undefined;
    return thinking ?? DEFAULT_THINKING;
}

/** The display the session runs with, or `undefined` when we cannot know (thinking off, or inherited from the CLI's own settings). */
export function thinkingDisplayOf(thinking: ThinkingConfig | null | undefined): ThinkingDisplay | undefined {
    const t = resolveThinking(thinking);
    if (!t || t.type === 'disabled') return undefined;
    return t.display ?? 'omitted';
}

/**
 * The `maxThinkingTokens` argument that leaves the session's thinking MODE
 * alone while `setMaxThinkingTokens` changes only its display: a fixed budget
 * stays fixed, `0` stays disabled, and adaptive (or unknown) is `null` — no
 * limit.
 */
export function thinkingBudgetOf(thinking: ThinkingConfig | null | undefined): number | null {
    const t = resolveThinking(thinking);
    if (t?.type === 'enabled' && t.budgetTokens !== undefined) return t.budgetTokens;
    if (t?.type === 'disabled') return 0;
    return null;
}

/**
 * The settings this session advertises. A value we do not know yet is absent
 * — `configOptions` leaves the option out rather than inventing a current.
 */
export interface ConfigState {
    readonly model?: string;
    readonly permissionMode?: string;
    readonly thinkingDisplay?: ThinkingDisplay;
}

/**
 * The session's one source of truth for what it advertises.
 *
 * A `config` event is THE options, not a patch of them — the reducer replaces
 * the list wholesale. So both places that emit one (`system/init` and
 * `configure()`) have to announce every setting, which means they need
 * somewhere to merge into: announcing only what just changed empties every
 * other control the client is driving off it (#137).
 */
export interface ConfigTracker {
    current(): ConfigState;
    /** What to advertise right now: the state, over the model list this session offers. */
    options(): ConfigOption[];
    /**
     * Merge. A key the patch does not set keeps its value — and since every
     * field is optional, a key set to `undefined` counts as not set rather
     * than as "clear this", so building a patch out of `string | undefined`
     * values cannot silently unadvertise a setting.
     */
    update(patch: ConfigState): ConfigState;
}

/**
 * What `configure()` asked for, in the SDK's own vocabulary.
 *
 * `configure()` before the first `query()` has nothing live to apply a setting
 * to (#139), so it RECORDS the patch here and `toQueryOptions` folds it into
 * the options the query starts with. Kept apart from `ConfigState` on purpose:
 * that tracks what the session ADVERTISES, which `system/init` also writes to
 * — folding the whole of it back into `query()` would start sending the CLI's
 * own resolved id (a gateway or Bedrock id behind an alias) back as `model`.
 *
 * The same record survives a RESTART: a `prompt(input, { output })` with a new
 * schema starts a fresh query, which would otherwise rebuild its options from
 * the session options alone and quietly undo every `configure()` the session
 * has taken.
 */
export interface PendingConfig {
    readonly model?: string;
    readonly permissionMode?: PermissionMode;
    readonly thinkingDisplay?: ThinkingDisplay;
}

/**
 * The permission mode a query runs under: what `configure()` asked for, then
 * the session's, then the agent's. ONE resolution, shared by `toQueryOptions`
 * and by what a session advertises when it opens — so the value advertised and
 * the value actually sent cannot drift.
 */
export function resolvePermissionMode(agent: ClaudeCodeOptions, session: ClaudeCodeSessionOptions, pending: PendingConfig = {}): PermissionMode {
    return pending.permissionMode ?? session.permissionMode ?? agent.permissionMode ?? 'default';
}

/**
 * The session's thinking with the display `configure()` chose. The MODE is
 * untouched, exactly as `setMaxThinkingTokens(budget, display)` leaves it
 * mid-session.
 */
function withDisplay(thinking: ThinkingConfig | undefined, display: ThinkingDisplay | undefined): ThinkingConfig | undefined {
    if (!thinking || display === undefined || thinking.type === 'disabled') return thinking;
    return { ...thinking, display };
}

export function createConfigState(initial: ConfigState = {}, models?: readonly ConfigValue[]): ConfigTracker {
    let state: ConfigState = initial;
    return {
        current: () => state,
        options: () => configOptions(state, models),
        update(patch) {
            const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
            state = { ...state, ...defined };
            return state;
        }
    };
}

/**
 * The model values to advertise. The session's current model goes first when
 * the list does not already name it — `system/init` reports whatever the CLI
 * resolved (a full id behind an alias, a Bedrock / Vertex / gateway id), and
 * `ConfigOption.current` has to be one of `values` for a client to render it
 * as the selected entry at all.
 */
function modelValues(current: string, models: readonly ConfigValue[]): ConfigValue[] {
    return models.some((m) => m.id === current) ? [...models] : [{ id: current }, ...models];
}

/**
 * What a `config` event advertises — one entry per setting we know the
 * current value of, so a client can both show it and switch it through
 * `configure()`.
 */
export function configOptions(current: ConfigState, models: readonly ConfigValue[] = CLAUDE_CODE_MODELS): ConfigOption[] {
    return [
        ...(current.model !== undefined ? [{ id: 'model', label: 'Model', values: modelValues(current.model, models), current: current.model }] : []),
        ...(current.permissionMode !== undefined ? [{ id: 'permissionMode', label: 'Permission mode', values: PERMISSION_MODES.map((id) => ({ id })), current: current.permissionMode }] : []),
        ...(current.thinkingDisplay !== undefined
            ? [
                  {
                      id: 'thinkingDisplay',
                      label: 'Thinking',
                      values: [
                          { id: 'summarized', label: 'Summarized', description: "Stream a summary of Claude's thinking as reasoning parts." },
                          { id: 'omitted', label: 'Hidden', description: 'Report that Claude is thinking, but none of it.' }
                      ],
                      current: current.thinkingDisplay
                  }
              ]
            : [])
    ];
}

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
            if (p.data !== undefined) content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } });
            else if (p.url !== undefined) content.push({ type: 'image', source: { type: 'url', url: p.url } });
            else throw new AgentError('protocol_error', '[sigx ai-agent-claude-code] an image part needs data or url');
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

/** `SessionOptions.agents` → the SDK's programmatic sub-agents. A definition without a prompt uses its description. */
export function toAgentDefinitions(agents: Readonly<Record<string, AgentDefinition>>): Record<string, SdkAgentDefinition> {
    const out: Record<string, SdkAgentDefinition> = {};
    for (const [name, def] of Object.entries(agents)) {
        out[name] = {
            description: def.description,
            prompt: def.prompt ?? def.description,
            ...(def.tools ? { tools: [...def.tools] } : {}),
            ...(def.model !== undefined ? { model: def.model } : {}),
            ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {})
        };
    }
    return out;
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
    /** What `configure()` has asked for so far — applied to every query this session starts (#139). */
    readonly pending?: PendingConfig;
}

export function toQueryOptions(input: QueryOptionsInput): Options {
    const { agent, session } = input;
    const pending = input.pending ?? {};
    const mode = resolvePermissionMode(agent, session, pending);
    if (mode === 'bypassPermissions' && !agent.allowDangerouslySkipPermissions) {
        throw new AgentError('protocol_error', '[sigx ai-agent-claude-code] permissionMode "bypassPermissions" needs allowDangerouslySkipPermissions: true — every tool would run unasked');
    }
    const system = session.system;
    const thinking = withDisplay(resolveThinking(session.thinking), pending.thinkingDisplay);
    const model = pending.model ?? session.model;
    return {
        cwd: session.cwd,
        ...(thinking ? { thinking } : {}),
        ...(model !== undefined ? { model } : {}),
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
        // Sub-agents: the SDK forwards only tool frames by default; the nested transcript is ours to render.
        ...(session.subagentTranscript !== false ? { forwardSubagentText: true } : {}),
        ...(session.agentProgressSummaries ? { agentProgressSummaries: true } : {}),
        ...(session.agents ? { agents: toAgentDefinitions(session.agents) } : {}),
        ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
        ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
        ...(input.spawn ? { spawnClaudeCodeProcess: input.spawn } : {}),
        ...(input.pathToClaudeCodeExecutable !== undefined ? { pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable } : {})
    };
}
