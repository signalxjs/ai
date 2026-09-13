/**
 * Agent definitions on our engine (`defineAgents`).
 *
 * `session({ agents: { reviewer: { description, prompt, tools, maxTurns } } })`
 * gives the model one tool per definition, named after it. Calling it runs a
 * nested `modelAgent` — the same model, the definition's prompt as its system
 * prompt, only the tools it names — through `agentTool`, so the sub-agent
 * framing, request routing, cancel and usage attribution come for free. The
 * definition's `model` is a harness alias; our engine has one model and
 * ignores it.
 */

import type { AnyTool, JsonSchema, StandardSchemaV1 } from '@sigx/ai';
import { AgentError } from '../protocol/index.js';
import type { Agent, AgentDefinition, SessionOptions } from '../session/index.js';
// `agentTool` type-imports this folder's tool context; the runtime edge runs one way (here → agent-tool).
import { agentTool } from '../agent-tool/index.js';

/** The rule `defineTool` enforces on a tool name — a definition's name becomes one. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const TASK_JSON: JsonSchema = {
    type: 'object',
    properties: { task: { type: 'string', description: 'What the sub-agent should do, in full — it sees this task and its own instructions, not this conversation.' } },
    required: ['task'],
    additionalProperties: false
};

interface Task {
    readonly task: string;
}

/** Exactly `{ task: string }` — the same shape `TASK_JSON` promises the provider. */
const isTask = (v: unknown): v is Task => typeof v === 'object' && v !== null && typeof (v as { task?: unknown }).task === 'string' && Object.keys(v).length === 1;

const taskSchema: StandardSchemaV1<Task, Task> = {
    '~standard': { version: 1, vendor: 'sigx-ai-agent', validate: (v) => (isTask(v) ? { value: v } : { issues: [{ message: 'expected { task: string } and nothing else' }] }) }
};

export interface DefinitionHost {
    readonly id: string;
    /** Build the delegate agent for one definition over the tools it may use. */
    readonly delegate: (name: string, definition: AgentDefinition, tools: readonly AnyTool[]) => Agent;
}

/**
 * One tool per definition, appended after `tools`. Throws `protocol_error` for
 * a name that is not a valid tool name, a name a tool already has, or a
 * definition naming a tool the session does not have — at `session()` time,
 * before the model ever sees the roster.
 */
export function definitionTools(definitions: Readonly<Record<string, AgentDefinition>>, tools: readonly AnyTool[], session: SessionOptions, host: DefinitionHost): AnyTool[] {
    const byName = new Map(tools.map((t) => [t.name, t] as const));
    const taken = new Set(byName.keys());
    const out: AnyTool[] = [];
    for (const [name, definition] of Object.entries(definitions)) {
        if (!TOOL_NAME.test(name)) throw new AgentError('protocol_error', `[sigx ai-agent] agent definition "${name}" is not a valid tool name — letters, digits, "_" and "-", up to 64 characters`);
        if (taken.has(name)) throw new AgentError('protocol_error', `[sigx ai-agent] agent definition "${name}" collides with a tool of the same name`);
        taken.add(name);
        let own: readonly AnyTool[] = tools;
        if (definition.tools) {
            const seen = new Set<string>();
            own = definition.tools.map((toolName) => {
                const tool = byName.get(toolName);
                if (!tool) throw new AgentError('protocol_error', `[sigx ai-agent] agent definition "${name}" names a tool the session does not have: "${toolName}"`);
                if (seen.has(toolName)) throw new AgentError('protocol_error', `[sigx ai-agent] agent definition "${name}" names the tool "${toolName}" twice`);
                seen.add(toolName);
                return tool;
            });
        }
        out.push(
            agentTool(host.delegate(name, definition, own), {
                name,
                title: name,
                description: definition.description,
                input: taskSchema,
                jsonSchema: TASK_JSON,
                prompt: (input) => input.task,
                // The delegate asks and is governed the way the host session is.
                sessionOptions: {
                    ...(session.policy ? { policy: session.policy } : {}),
                    interactive: session.interactive ?? true,
                    ...(session.requestTimeoutMs !== undefined ? { requestTimeoutMs: session.requestTimeoutMs } : {})
                }
            })
        );
    }
    return out;
}
