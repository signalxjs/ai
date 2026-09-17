/**
 * Client tools as Codex dynamic tools — registered at `thread/start` from
 * `AnyTool.spec`, answered on `item/tool/call` through the policy and
 * `AnyTool.run`. `tools: 'native'`: no MCP hop.
 */

import type { AnyTool } from '@sigx/ai';
import type { Resolve } from './approvals.js';
import type { DynamicToolCallParams, DynamicToolCallResponse, DynamicToolFunctionSpec, JsonValue } from './schema.js';

export function toDynamicTools(tools: readonly AnyTool[]): DynamicToolFunctionSpec[] {
    return tools.map((t) => ({ type: 'function', name: t.spec.name, description: t.spec.description, inputSchema: t.spec.inputSchema as JsonValue }));
}

export interface ToolCallContext {
    readonly signal: AbortSignal;
    readonly resolve: Resolve;
    readonly onStatus?: (status: 'in_progress' | 'denied', message?: string) => void;
}

/** Run a dynamic tool call: policy first, then the tool; failures come back as `success: false` text. */
export async function callDynamicTool(tools: readonly AnyTool[], params: DynamicToolCallParams, ctx: ToolCallContext): Promise<DynamicToolCallResponse> {
    const tool = tools.find((t) => t.name === params.tool);
    if (!tool) return { contentItems: [{ type: 'inputText', text: `Unknown tool "${params.tool}".` }], success: false };
    const resolved = await ctx.resolve({
        kind: 'permission',
        callId: params.callId,
        toolName: tool.name,
        input: params.arguments,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        source: 'client',
        permissionKey: `tool:${tool.name}`
    });
    const d = resolved.decision;
    if (d.type !== 'permission' || d.outcome !== 'allow') {
        const message = d.type === 'permission' ? (d.message ?? `Tool "${tool.name}" was denied by policy.`) : `Tool "${tool.name}" was not run: the turn was cancelled.`;
        ctx.onStatus?.('denied', message);
        return { contentItems: [{ type: 'inputText', text: message }], success: false };
    }
    ctx.onStatus?.('in_progress');
    try {
        const output = await tool.run(params.arguments, { signal: ctx.signal, toolCallId: params.callId });
        return { contentItems: [{ type: 'inputText', text: typeof output === 'string' ? output : JSON.stringify(output ?? null) }], success: true };
    } catch (e) {
        return { contentItems: [{ type: 'inputText', text: e instanceof Error ? e.message : String(e) }], success: false };
    }
}
