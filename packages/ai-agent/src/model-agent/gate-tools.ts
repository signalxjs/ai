/**
 * Tool gating — every client tool call reaches the policy.
 *
 * Each tool is copied with `approval` always on, so the engine asks
 * `onToolApproval` before every call; that handler runs `resolveRequest`
 * (policy → session grant → the client through a `request` event → timeout)
 * and answers `'allow'` or a denial the model sees as an error result. Tools
 * run with a context that can emit nested events (`agentTool` uses it).
 */

import { validateWith, type AnyTool, type StreamTextOptions, type ToolContext } from '@sigx/ai';
import type { UnstampedEvent } from '../protocol/index.js';
import type { PolicyRequest, Resolved } from '../policy/index.js';
import type { TurnDriver } from '../session/index.js';

/** What a tool run by `modelAgent` receives — the core context plus a way to emit nested events. */
export interface AgentToolContext extends ToolContext {
    /** Emit an event inside this call (stamped with the turn; `parentCallId` defaults to this call). */
    readonly emit: (event: UnstampedEvent) => void;
}

export interface GateOptions {
    readonly driver: TurnDriver;
    readonly resolve: (request: PolicyRequest) => Promise<Resolved>;
}

export interface GatedTools {
    readonly tools: AnyTool[];
    readonly onToolApproval: NonNullable<StreamTextOptions['onToolApproval']>;
}

export function gateTools(tools: readonly AnyTool[], options: GateOptions): GatedTools {
    const { driver } = options;
    const byName = new Map(tools.map((t) => [t.name, t] as const));
    const gated: AnyTool[] = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        spec: tool.spec,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        // Bad arguments fail here, before any policy or human is asked — the
        // same order `defineTool`'s own `needsApproval` keeps.
        approval: async (raw) => {
            await validateWith(tool.input, raw, `Invalid arguments for tool "${tool.name}"`);
            return true;
        },
        run: (raw, ctx) => {
            const nested: AgentToolContext = {
                ...ctx,
                emit: (event) => {
                    driver.emit({ ...event, ...(event.parentCallId === undefined ? { parentCallId: ctx.toolCallId } : {}) });
                }
            };
            return tool.run(raw, nested);
        }
    }));
    return {
        tools: gated,
        onToolApproval: async (call) => {
            const tool = byName.get(call.name);
            const resolved = await options.resolve({
                kind: 'permission',
                callId: call.id,
                toolName: call.name,
                input: call.input,
                ...(tool?.annotations ? { annotations: tool.annotations } : {}),
                source: 'client',
                permissionKey: `tool:${call.name}`
            });
            const d = resolved.decision;
            if (d.type === 'permission' && d.outcome === 'allow') {
                driver.emit({ type: 'tool-update', callId: call.id, status: 'in_progress' });
                return 'allow';
            }
            if (d.type === 'permission') return { deny: d.message ?? `Tool "${call.name}" was denied by policy.` };
            return { deny: `Tool "${call.name}" was not run: the turn was cancelled.` };
        }
    };
}
