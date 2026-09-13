/**
 * `canUseTool` ↔ the policy. Every question the CLI asks goes through
 * `resolveRequest` (policy → session grant → the client → timeout); the
 * answer is `allow` with the input unchanged or `deny` with a message the
 * model sees. Grants stay in the session's memory — never
 * `updatedPermissions`, never a settings file.
 *
 * `AskUserQuestion` is the exception: it is not a permission but a question
 * for the operator, so it resolves as `kind: 'input'` and the answers ride
 * back on `updatedInput` (see `questions.ts`).
 */

import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { TurnContext } from '@sigx/ai-agent';
import { ASK_USER_QUESTION, parseQuestions, questionOptions, questionsMessage, questionsSchema, toAskAnswers } from './questions.js';
import { categoryFor, primaryArg, splitToolName, toolAnnotations } from './request.js';

export interface PermissionTarget {
    /** The turn that is running, if any — its `resolve` is the policy entry point. */
    readonly ctx: TurnContext;
    /** A call id the SDK announced for this tool use, when known. */
    callIdFor(toolName: string, input: unknown): string | undefined;
    /** Remember a denial so the call's result reads `denied`, not `failed`. */
    markDenied(toolName: string, input: unknown, callId?: string): void;
}

export function createCanUseTool(current: () => PermissionTarget | undefined, serverName: string): CanUseTool {
    return async (rawName, input, options) => {
        const target = current();
        if (!target) return { behavior: 'deny', message: 'No turn is running.' };
        const { name, source } = splitToolName(rawName, serverName);
        const annotations = source === 'native' ? toolAnnotations(name) : undefined;
        const callId = (options as { toolUseID?: string }).toolUseID ?? target.callIdFor(rawName, input);

        // The CLI's own question tool: an input request, answered through `updatedInput`.
        const questions = source === 'native' && name === ASK_USER_QUESTION ? parseQuestions(input) : undefined;
        if (questions) {
            const asked = await target.ctx.resolve({
                kind: 'input',
                toolName: name,
                input,
                source,
                ...(callId !== undefined ? { callId } : {}),
                message: questionsMessage(questions),
                options: questionOptions(questions),
                schema: questionsSchema(questions)
            });
            if (asked.decision.type === 'input') return { behavior: 'allow', updatedInput: { ...input, answers: toAskAnswers(questions, asked.decision.answers) } };
            target.markDenied(rawName, input, callId);
            const message = asked.decision.type === 'permission' ? asked.decision.message : undefined;
            return { behavior: 'deny', message: message ?? 'The questions were not answered.' };
        }

        const resolved = await target.ctx.resolve({
            kind: 'permission',
            toolName: name,
            input,
            source,
            ...(callId !== undefined ? { callId } : {}),
            ...(annotations ? { annotations } : {}),
            ...(categoryFor(name) !== undefined ? { category: categoryFor(name)! } : {}),
            ...(options.title !== undefined ? { message: options.title } : {}),
            permissionKey: `${name}:${primaryArg(input)}`
        });
        const d = resolved.decision;
        if (d.type === 'permission' && d.outcome === 'allow') return { behavior: 'allow', updatedInput: input };
        target.markDenied(rawName, input, callId);
        if (d.type === 'permission') return { behavior: 'deny', message: d.message ?? `Tool "${name}" was denied by policy.` };
        return { behavior: 'deny', message: `Tool "${name}" was not run: the turn was cancelled.` };
    };
}
