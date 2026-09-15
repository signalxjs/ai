import { describe, it, expect } from 'vitest';
import { baseCatalog, describeCatalog, specJsonSchema, uiToolJsonSchema } from '../../src/index.js';

describe('specJsonSchema', () => {
    it('is a loose recursive node schema with type restricted to the catalog and children last', () => {
        const schema = specJsonSchema(baseCatalog) as { $defs: { node: { properties: Record<string, unknown>; required: string[] } }; required: string[] };
        expect(schema.required).toEqual(['root']);
        expect(Object.keys(schema.$defs.node.properties)).toEqual(['type', 'id', 'props', 'if', 'for', 'bind', 'on', 'children']);
        expect((schema.$defs.node.properties.type as { enum: string[] }).enum).toEqual(Object.keys(baseCatalog.components));
        expect(schema.$defs.node.properties.children).toEqual({ type: 'array', items: { $ref: '#/$defs/node' } });
        expect(schema.$defs.node.required).toEqual(['type']);
    });
    it('the tool schema wraps it in { spec } and hoists $defs so $refs resolve', () => {
        const tool = uiToolJsonSchema(baseCatalog) as { properties: { spec: Record<string, unknown> }; $defs: Record<string, unknown>; required: string[] };
        expect(tool.required).toEqual(['spec']);
        expect(Object.keys(tool.$defs)).toEqual(['expr', 'step', 'node']);
        expect('$defs' in tool.properties.spec).toBe(false);
        expect(tool.properties.spec.required).toEqual(['root']);
    });
});

describe('describeCatalog', () => {
    it('lists every component with its props and events, every action and helper, and the rules', () => {
        const text = describeCatalog(baseCatalog);
        for (const name of Object.keys(baseCatalog.components)) expect(text).toContain(`**${name}**`);
        expect(text).toContain('label: string (required)');
        expect(text).toContain('variant: primary|secondary|ghost|danger');
        expect(text).toContain('input ($event.value)');
        expect(text).toContain('supports "bind"');
        expect(text).toContain('**state.set**');
        expect(text).toContain('where(list, predicate)');
        expect(text).toContain('No functions or lambdas');
        expect(text).toContain('"type" first and "children" last');
    });
    it('can leave the rules and helpers out', () => {
        const text = describeCatalog(baseCatalog, { rules: false, helpers: false });
        expect(text).not.toContain('### Expressions');
        expect(text).not.toContain('### Helpers');
    });
});
