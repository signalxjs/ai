/**
 * Client tools as Copilot tools — declared on the session from
 * `AnyTool.spec` (the JSON Schema goes through as-is) and run in-process by
 * the SDK's handler. `tools: 'native'`: no MCP hop.
 *
 * Permission: the runtime asks `onPermissionRequest` (`kind: 'custom-tool'`)
 * before it calls the handler, and that ask went through the policy. A
 * runtime that skips the ask (`skipPermission`, an older CLI) still meets the
 * policy here — the handler asks itself when nobody asked for this call.
 */

import type { Tool, ToolInvocation, ToolResultObject } from '@github/copilot-sdk';
import type { AnyTool } from '@sigx/ai';
import type { ToolStatus, TurnContext } from '@sigx/ai-agent';

export interface ToolTarget {
    readonly ctx: TurnContext;
    /** The turn's signal — aborts on `cancel()`. */
    readonly signal: AbortSignal;
    /** Whether the permission for this call was already resolved (by `onPermissionRequest`). */
    resolved(callId: string): boolean;
    /** Announce the call in the transcript (idempotent) and move its status. */
    announce(callId: string, name: string, input: unknown): void;
    status(callId: string, status: ToolStatus, detail?: { readonly output?: unknown; readonly error?: string }): void;
}

export function toCopilotTools(tools: readonly AnyTool[], current: () => ToolTarget | undefined): Tool[] {
    return tools.map((tool) => ({
        name: tool.spec.name,
        description: tool.spec.description,
        parameters: tool.spec.inputSchema as Record<string, unknown>,
        handler: (args: unknown, invocation: ToolInvocation) => runTool(tool, args, invocation, current())
    }));
}

const failure = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: 'failure', error: text });

async function runTool(tool: AnyTool, args: unknown, invocation: ToolInvocation, target: ToolTarget | undefined): Promise<ToolResultObject> {
    if (!target) return failure('No turn is running.');
    const callId = invocation.toolCallId;
    target.announce(callId, tool.name, args);
    if (!target.resolved(callId)) {
        const resolved = await target.ctx.resolve({
            kind: 'permission',
            callId,
            toolName: tool.name,
            input: args,
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
            source: 'client',
            permissionKey: `tool:${tool.name}`
        });
        const d = resolved.decision;
        if (d.type !== 'permission' || d.outcome !== 'allow') {
            const message = d.type === 'permission' ? (d.message ?? `Tool "${tool.name}" was denied by policy.`) : `Tool "${tool.name}" was not run: the turn was cancelled.`;
            target.status(callId, 'denied', { error: message });
            return { textResultForLlm: message, resultType: 'denied', error: message };
        }
    }
    target.status(callId, 'in_progress');
    try {
        const output = await tool.run(args, { signal: target.signal, toolCallId: callId });
        const text = typeof output === 'string' ? output : JSON.stringify(output ?? null);
        target.status(callId, 'completed', { output });
        return { textResultForLlm: text, resultType: 'success' };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        target.status(callId, 'failed', { error: message });
        return failure(message);
    }
}
