/**
 * `onPermissionRequest` / `onUserInputRequest` ↔ the policy. Every question
 * the runtime asks goes through the running turn's `resolve` (policy →
 * session grant → the client → timeout) and comes back as one of Copilot's
 * decisions. Grants stay in the session's memory: the runtime is told
 * `approve-once` or `approve-for-session`, never anything that persists to
 * its settings.
 *
 * The runtime asks for OUR client tools too (`kind: 'custom-tool'`): that is
 * where they get their permission, so the tool handler runs without asking
 * again.
 */

import type { PermissionHandler, PermissionRequest, PermissionRequestResult } from '@github/copilot-sdk';
import type { Decision, PolicyRequest, TurnContext } from '@sigx/ai-agent';
import { codingEvent } from '@sigx/ai-agent/coding';
import type { UnstampedEvent } from '@sigx/ai-agent';
import type { UserInputHandler } from './options.js';

export interface PermissionTarget {
    /** The turn that is running — its `resolve` is the policy entry point. */
    readonly ctx: TurnContext;
    /** Announce the call the ask is about (idempotent), so a denial has a call to land on. */
    announce(callId: string, name: string, input: unknown): void;
    /** Remember a denial so the call's completion reads `denied`, not `failed`. */
    markDenied(callId: string, message: string): void;
    emit(event: UnstampedEvent): void;
}

/** The policy request for one of Copilot's permission asks. */
export function toPolicyRequest(request: PermissionRequest): PolicyRequest {
    const callId = request.toolCallId !== undefined ? { callId: request.toolCallId } : {};
    switch (request.kind) {
        case 'shell':
            return {
                kind: 'permission',
                ...callId,
                toolName: 'shell',
                input: { command: request.fullCommandText, intention: request.intention, ...(request.possiblePaths.length ? { paths: request.possiblePaths } : {}) },
                category: 'execute',
                source: 'native',
                message: request.warning ?? request.intention,
                permissionKey: `shell:${request.fullCommandText}`
            };
        case 'write':
            return {
                kind: 'permission',
                ...callId,
                toolName: 'write',
                input: { path: request.fileName, diff: request.diff, intention: request.intention },
                category: 'edit',
                source: 'native',
                message: request.intention,
                permissionKey: `write:${request.fileName}`
            };
        case 'read':
            return { kind: 'permission', ...callId, toolName: 'read', input: { path: request.path, intention: request.intention }, category: 'read', source: 'native', message: request.intention, permissionKey: `read:${request.path}` };
        case 'url':
            return { kind: 'permission', ...callId, toolName: 'fetch', input: { url: request.url, intention: request.intention }, category: 'fetch', source: 'native', message: request.intention, permissionKey: `fetch:${request.url}` };
        case 'mcp':
            return {
                kind: 'permission',
                ...callId,
                toolName: `${request.serverName}/${request.toolName}`,
                input: request.args,
                annotations: { readOnly: request.readOnly },
                source: 'mcp',
                message: request.toolTitle,
                permissionKey: `mcp:${request.serverName}/${request.toolName}`
            };
        case 'custom-tool':
            return { kind: 'permission', ...callId, toolName: request.toolName, input: request.args, source: 'client', message: request.toolDescription, permissionKey: `tool:${request.toolName}` };
        case 'memory':
            return { kind: 'permission', ...callId, toolName: 'memory', input: { fact: request.fact, ...(request.action ? { action: request.action } : {}) }, category: 'other', source: 'native', ...(request.reason ? { message: request.reason } : {}), permissionKey: 'memory' };
        case 'hook':
            return { kind: 'permission', ...callId, toolName: request.toolName, input: request.toolArgs, category: 'other', source: 'native', ...(request.hookMessage ? { message: request.hookMessage } : {}), permissionKey: `hook:${request.toolName}` };
        default: {
            const other = request as { kind: string; toolCallId?: string };
            return { kind: 'permission', ...callId, toolName: other.kind, input: request, category: 'other', source: 'native', permissionKey: other.kind };
        }
    }
}

/** A decision as the runtime wants it. Only a per-session allow becomes a session approval; everything else is one-off. */
export function toCopilotDecision(decision: Decision, canOfferSessionApproval = true): PermissionRequestResult {
    if (decision.type === 'permission' && decision.outcome === 'allow') {
        return decision.scope === 'session' && canOfferSessionApproval ? { kind: 'approve-for-session' } : { kind: 'approve-once' };
    }
    if (decision.type === 'permission') return { kind: 'reject', ...(decision.message !== undefined ? { feedback: decision.message } : {}) };
    return { kind: 'reject', feedback: 'The turn was cancelled.' };
}

export function createPermissionHandler(current: () => PermissionTarget | undefined): PermissionHandler {
    return async (request) => {
        const target = current();
        if (!target) return { kind: 'user-not-available' };
        const policy = toPolicyRequest(request);
        if (request.toolCallId !== undefined) target.announce(request.toolCallId, policy.toolName ?? request.kind, policy.input);
        // A write shows its diff before it happens; the transcript gets it either way.
        if (request.kind === 'write' && request.diff) {
            target.emit(codingEvent('diff', { path: request.fileName, unifiedDiff: request.diff }, request.toolCallId !== undefined ? { parentCallId: request.toolCallId } : {}));
        }
        const resolved = await target.ctx.resolve(policy);
        const d = resolved.decision;
        if (!(d.type === 'permission' && d.outcome === 'allow') && request.toolCallId !== undefined) {
            target.markDenied(request.toolCallId, d.type === 'permission' ? (d.message ?? `"${policy.toolName}" was denied by policy.`) : 'The turn was cancelled.');
        }
        const canOfferSession = 'canOfferSessionApproval' in request ? request.canOfferSessionApproval : true;
        return toCopilotDecision(d, canOfferSession);
    };
}

/** The `ask_user` tool: a question for the operator, resolved as `kind: 'input'`. */
export function createUserInputHandler(current: () => PermissionTarget | undefined): UserInputHandler {
    return async (request) => {
        const target = current();
        if (!target) return { answer: '', wasFreeform: true };
        const choices = request.choices ?? [];
        const resolved = await target.ctx.resolve({
            kind: 'input',
            toolName: 'ask_user',
            input: request,
            source: 'native',
            message: request.question,
            ...(choices.length ? { options: choices.map((c) => ({ id: c, label: c })) } : {}),
            ...(request.allowFreeform !== false || !choices.length ? { schema: { type: 'string' } } : {})
        });
        const d = resolved.decision;
        if (d.type !== 'input') return { answer: '', wasFreeform: true };
        const answer = answerText(d.answers);
        return { answer, wasFreeform: !choices.includes(answer) };
    };
}

/** The operator's answer as the one string the tool takes: a string, a chosen option id, or the first value of an object. */
export function answerText(answers: unknown): string {
    if (typeof answers === 'string') return answers;
    if (Array.isArray(answers)) return answers.map(answerText).filter(Boolean).join(', ');
    if (answers && typeof answers === 'object') {
        const values = Object.values(answers as Record<string, unknown>);
        return values.length ? answerText(values[0]) : '';
    }
    return answers === undefined || answers === null ? '' : String(answers);
}
