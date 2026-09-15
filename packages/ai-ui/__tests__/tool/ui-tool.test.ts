import { describe, it, expect } from 'vitest';
import { SchemaValidationError, generateText } from '@sigx/ai';
import { mockModel } from '@sigx/ai/testing';
import { uiTool, type UIToolResult } from '../../src/index.js';

const ctx = { signal: new AbortController().signal, toolCallId: 'c1' };

describe('uiTool', () => {
    it('is a tool named render_ui whose description carries the catalog and whose schema is the spec schema', () => {
        const tool = uiTool();
        expect(tool.name).toBe('render_ui');
        expect(tool.description).toContain('### Components');
        expect(tool.description).toContain('**button**');
        expect((tool.spec.inputSchema as { required: string[] }).required).toEqual(['spec']);
        expect(tool.annotations?.readOnly).toBe(true);
    });

    it('accepts a valid spec, returning the warnings, and rejects an invalid one before execute', async () => {
        const tool = uiTool();
        const ok = (await tool.run({ spec: { root: { type: 'text', props: { text: 'hi', size: 1 } } } }, ctx)) as UIToolResult;
        expect(ok.rendered).toBe(true);
        expect(ok.issues.map((i) => i.message)).toEqual(['unknown prop "size" on text']);
        await expect(tool.run({ spec: { root: { type: 'nope' } } }, ctx)).rejects.toBeInstanceOf(SchemaValidationError);
        await expect(tool.run({}, ctx)).rejects.toBeInstanceOf(SchemaValidationError);
        try {
            await tool.run({ spec: { root: { type: 'nope' } } }, ctx);
        } catch (e) {
            expect((e as SchemaValidationError).issues[0]?.path).toEqual(['spec', 'root', 'type']);
        }
    });

    it('a custom name, description, catalog and execute', async () => {
        const tool = uiTool({ name: 'show', description: 'Show it.', execute: ({ spec }) => ({ nodes: spec.root ? 1 : 0 }) });
        expect(tool.name).toBe('show');
        expect(tool.description.startsWith('Show it.\n\n## UI spec')).toBe(true);
        expect(await tool.run({ spec: { root: { type: 'divider' } } }, ctx)).toEqual({ nodes: 1 });
    });

    it('runs through the tool loop: the model calls it, the transcript holds the spec as the tool input', async () => {
        const spec = { root: { type: 'button', props: { label: 'Hi' } } };
        const model = mockModel({
            script: [{ toolCalls: [{ name: 'render_ui', input: { spec }, inputDeltas: ['{"spec": {"root": {"type": "but', 'ton", "props": {"label": "Hi"}}}}'] }] }, { text: 'Here you go.' }]
        });
        const result = await generateText({ model, tools: [uiTool()], messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'ui' }] }] });
        const tool = result.message.parts.find((p) => p.type === 'tool');
        expect(tool && tool.type === 'tool' && tool.state).toBe('done');
        expect(tool && tool.type === 'tool' && tool.input).toEqual({ spec });
        expect(tool && tool.type === 'tool' && (tool.output as UIToolResult).rendered).toBe(true);
    });
});
