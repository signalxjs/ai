/**
 * `uiTool` — a `@sigx/json-ui` spec as a tool the model calls. The tool loop streams the
 * call's arguments (`tool-input` deltas), and the core's reducer already
 * re-parses them into `UIToolPart.input` on every token, so a `UIView` fed
 * that part's `input.spec` renders the UI as the model writes it — no
 * protocol change, no server round trip for the rendering.
 */

import { baseCatalog, describeCatalog, specJsonSchema, uiSpecSchema, validateSpec, type UICatalog, type UIIssue, type UISpec } from '@sigx/json-ui';
import type { JsonSchema, StandardSchemaV1 } from '../schema/index.js';
import { defineTool, type Tool, type ToolContext } from '../tool/index.js';

export interface UIToolInput {
    readonly spec: UISpec;
}

export interface UIToolResult {
    readonly rendered: true;
    /** Warnings the spec produced (errors reject the call before `execute`). */
    readonly issues: UIIssue[];
}

export interface UIToolOptions<O = UIToolResult> {
    /** @default baseCatalog */
    readonly catalog?: UICatalog;
    /** @default 'render_ui' */
    readonly name?: string;
    /** Replaces the default instruction; the catalog section is appended either way. */
    readonly description?: string;
    /** Runs after validation; the default returns `{ rendered: true, issues }`. */
    readonly execute?: (input: UIToolInput, ctx: ToolContext) => O | Promise<O>;
}

const DEFAULT_DESCRIPTION =
    'Render an interactive UI for the user, inline in the conversation. Use it whenever a form, a list, a dashboard, a calculator, a picker or any visual layout answers better than prose. ' +
    'The UI appears while you write it, so write "state" first and "root" last, and keep the JSON well-formed. ' +
    'Buttons can talk back to you: { "do": "emit", "name": "send", "payload": { "text": "…" } } sends a chat message.';

/** The tool's wire schema: `{ spec }` with the spec schema's `$defs` hoisted to the root so `$ref`s resolve. */
export function uiToolJsonSchema(catalog: UICatalog): JsonSchema {
    const { $defs, ...spec } = specJsonSchema(catalog);
    return {
        type: 'object',
        properties: { spec },
        required: ['spec'],
        additionalProperties: false,
        $defs
    };
}

export function uiToolInputSchema(catalog: UICatalog): StandardSchemaV1<UIToolInput, UIToolInput> {
    const spec = uiSpecSchema(catalog);
    return {
        '~standard': {
            version: 1,
            vendor: 'sigx-json-ui',
            async validate(value: unknown) {
                if (typeof value !== 'object' || value === null) return { issues: [{ message: 'input must be an object', path: [] }] };
                const result = await spec['~standard'].validate((value as { spec?: unknown }).spec);
                if ('issues' in result && result.issues) return { issues: result.issues.map((i) => ({ message: i.message, path: ['spec', ...((i.path as (string | number)[] | undefined) ?? [])] })) };
                return { value: { spec: (result as { value: UISpec }).value } };
            }
        }
    };
}

export function uiTool<O = UIToolResult>(options: UIToolOptions<O> = {}): Tool<StandardSchemaV1<UIToolInput, UIToolInput>, O> {
    const catalog = options.catalog ?? baseCatalog;
    const execute =
        options.execute ??
        ((input: UIToolInput): O => ({ rendered: true, issues: validateSpec(input.spec, catalog).filter((i) => i.severity === 'warning') }) as unknown as O);
    return defineTool({
        name: options.name ?? 'render_ui',
        description: `${options.description ?? DEFAULT_DESCRIPTION}\n\n${describeCatalog(catalog)}`,
        input: uiToolInputSchema(catalog),
        jsonSchema: uiToolJsonSchema(catalog),
        annotations: { readOnly: true, idempotent: true },
        execute
    });
}
