/**
 * Approvals and questions — Codex's server→client requests, answered through
 * the session's policy (`resolveRequest`) and mapped back onto Codex's
 * decisions. Grants stay in the session's memory; nothing is written to
 * Codex's own trust settings.
 */

import type { JsonSchema } from '@sigx/ai';
import type { Decision, PolicyRequest, Resolved } from '@sigx/ai-agent';
import type {
    CommandExecutionApprovalDecision,
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    PermissionsRequestApprovalParams,
    PermissionsRequestApprovalResponse,
    ToolRequestUserInputParams,
    ToolRequestUserInputResponse
} from './schema.js';

export type Resolve = (request: PolicyRequest) => Promise<Resolved>;

/** `accept` / `acceptForSession` (when offered) / `decline` / `cancel`. */
export function toCodexDecision(decision: Decision, available?: readonly CommandExecutionApprovalDecision[] | null): 'accept' | 'acceptForSession' | 'decline' | 'cancel' {
    if (decision.type === 'cancel') return 'cancel';
    if (decision.type !== 'permission' || decision.outcome === 'deny') return 'decline';
    if (decision.scope === 'session' && (!available || available.includes('acceptForSession'))) return 'acceptForSession';
    return 'accept';
}

export async function approveCommand(params: CommandExecutionRequestApprovalParams, resolve: Resolve): Promise<CommandExecutionRequestApprovalResponse> {
    const command = params.command ?? '';
    const resolved = await resolve({
        kind: 'permission',
        callId: params.itemId,
        toolName: 'shell',
        input: { command, ...(params.cwd ? { cwd: params.cwd } : {}), ...(params.kind === 'writeStdin' ? { stdin: true } : {}) },
        category: 'execute',
        source: 'native',
        ...(params.reason ? { message: params.reason } : {}),
        permissionKey: `shell:${command}`
    });
    return { decision: toCodexDecision(resolved.decision, params.availableDecisions) };
}

export async function approveFileChange(params: FileChangeRequestApprovalParams, resolve: Resolve): Promise<FileChangeRequestApprovalResponse> {
    const resolved = await resolve({
        kind: 'permission',
        callId: params.itemId,
        toolName: 'apply_patch',
        input: params.grantRoot ? { grantRoot: params.grantRoot } : {},
        category: 'edit',
        source: 'native',
        ...(params.reason ? { message: params.reason } : {}),
        permissionKey: params.grantRoot ? `apply_patch:${params.grantRoot}` : 'apply_patch'
    });
    return { decision: toCodexDecision(resolved.decision) };
}

/** Allow grants the requested profile for the decision's scope; deny grants nothing. */
export async function approvePermissions(params: PermissionsRequestApprovalParams, resolve: Resolve): Promise<PermissionsRequestApprovalResponse> {
    const resolved = await resolve({
        kind: 'permission',
        callId: params.itemId,
        toolName: 'permissions',
        input: { permissions: params.permissions, cwd: params.cwd },
        category: 'other',
        source: 'native',
        ...(params.reason ? { message: params.reason } : {}),
        permissionKey: `permissions:${JSON.stringify(params.permissions)}`
    });
    const d = resolved.decision;
    if (d.type === 'permission' && d.outcome === 'allow') {
        return {
            permissions: {
                ...(params.permissions.network ? { network: params.permissions.network } : {}),
                ...(params.permissions.fileSystem ? { fileSystem: params.permissions.fileSystem } : {})
            },
            scope: d.scope === 'session' ? 'session' : 'turn'
        };
    }
    return { permissions: {}, scope: 'turn' };
}

/** One string (or enum) property per question. */
export function questionsSchema(params: ToolRequestUserInputParams): JsonSchema {
    const properties: Record<string, JsonSchema> = {};
    for (const q of params.questions) {
        properties[q.id] = {
            type: 'string',
            title: q.header,
            description: q.question,
            ...(q.options && !q.isOther ? { enum: q.options.map((o) => o.label) } : {}),
            ...(q.isSecret ? { format: 'password' } : {})
        };
    }
    return { type: 'object', properties, required: params.questions.map((q) => q.id), additionalProperties: false };
}

export async function askUserInput(params: ToolRequestUserInputParams, resolve: Resolve): Promise<ToolRequestUserInputResponse> {
    const resolved = await resolve({
        kind: 'input',
        callId: params.itemId,
        source: 'native',
        message: params.questions.map((q) => `${q.header}: ${q.question}`).join('\n'),
        options: params.questions.flatMap((q) => (q.options ?? []).map((o) => ({ id: `${q.id}:${o.label}`, label: o.label, description: o.description }))),
        schema: questionsSchema(params)
    });
    const answers: Record<string, { answers: string[] }> = {};
    const given = resolved.decision.type === 'input' ? resolved.decision.answers : undefined;
    for (const q of params.questions) {
        const value = typeof given === 'object' && given !== null ? (given as Record<string, unknown>)[q.id] : undefined;
        answers[q.id] = { answers: Array.isArray(value) ? value.map(String) : value === undefined || value === null ? [] : [String(value)] };
    }
    return { answers };
}
