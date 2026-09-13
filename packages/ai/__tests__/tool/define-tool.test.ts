import { describe, it, expect } from 'vitest';
import { defineTool, SchemaValidationError } from '@sigx/ai';
import { bareSchema, citySchema, isCity } from '../helpers';

describe('defineTool', () => {
    it('resolves the wire schema from Standard JSON Schema', () => {
        const t = defineTool({ name: 'weather', description: 'w', input: citySchema, execute: ({ city }) => city.toUpperCase() });
        expect(t.spec).toEqual({ name: 'weather', description: 'w', inputSchema: citySchema['~standard'].jsonSchema!.input({ target: 'draft-2020-12' }) });
    });

    it('prefers an explicit jsonSchema and carries strict', () => {
        const explicit = { type: 'object', properties: { city: { type: 'string' } } };
        const t = defineTool({ name: 'w', description: 'w', input: citySchema, jsonSchema: explicit, strict: true, execute: () => 1 });
        expect(t.spec.inputSchema).toBe(explicit);
        expect(t.spec.strict).toBe(true);
    });

    it('throws at definition when no JSON Schema can be derived', () => {
        expect(() => defineTool({ name: 'w', description: 'w', input: bareSchema(isCity), execute: () => 1 })).toThrow(/no JSON Schema/);
    });

    it('rejects an invalid tool name at definition', () => {
        expect(() => defineTool({ name: 'has space', description: 'w', input: citySchema, execute: () => 1 })).toThrow(/not a valid tool name/);
    });

    it('awaits an async validator, including a plain thenable', async () => {
        const thenableSchema = {
            '~standard': {
                version: 1 as const,
                vendor: 'test',
                validate: (v: unknown) => ({ then: (ok: (r: { value: unknown }) => void) => ok({ value: { city: String((v as { city: unknown }).city).toUpperCase() } }) }) as unknown as Promise<{ value: { city: string } }>,
                jsonSchema: citySchema['~standard'].jsonSchema
            }
        } as unknown as typeof citySchema;
        const t = defineTool({ name: 'w', description: 'w', input: thenableSchema, execute: ({ city }) => city });
        await expect(t.run({ city: 'oslo' }, { signal: new AbortController().signal, toolCallId: 'c' })).resolves.toBe('OSLO');
    });

    it('validates arguments before execute', async () => {
        const t = defineTool({ name: 'w', description: 'w', input: citySchema, execute: ({ city }) => `ok:${city}` });
        const ctx = { signal: new AbortController().signal, toolCallId: 'c1' };
        await expect(t.run({ city: 'Oslo' }, ctx)).resolves.toBe('ok:Oslo');
        await expect(t.run({ city: 1 }, ctx)).rejects.toBeInstanceOf(SchemaValidationError);
        await expect(t.run({ city: 1 }, ctx)).rejects.toThrow(/Invalid arguments for tool "w"/);
    });
    it('carries annotations and turns needsApproval into an approval check on the validated input', async () => {
        const ctx = { signal: new AbortController().signal, toolCallId: 'c' };
        const plain = defineTool({ name: 'p', description: 'p', input: citySchema, execute: () => 1 });
        expect(plain.approval).toBeUndefined();
        expect(plain.annotations).toBeUndefined();

        const always = defineTool({ name: 'a', description: 'a', input: citySchema, needsApproval: true, annotations: { destructive: true }, execute: () => 1 });
        expect(always.annotations).toEqual({ destructive: true });
        await expect(always.approval!({ city: 'Oslo' }, ctx)).resolves.toBe(true);

        const seen: string[] = [];
        const some = defineTool({
            name: 's',
            description: 's',
            input: citySchema,
            needsApproval: ({ city }) => {
                seen.push(city);
                return city === 'Oslo';
            },
            execute: () => 1
        });
        await expect(some.approval!({ city: 'Oslo' }, ctx)).resolves.toBe(true);
        await expect(some.approval!({ city: 'Rome' }, ctx)).resolves.toBe(false);
        await expect(some.approval!({ city: 1 }, ctx)).rejects.toBeInstanceOf(SchemaValidationError);
        expect(seen).toEqual(['Oslo', 'Rome']);
        // `false` is the same as not asking.
        expect(defineTool({ name: 'n', description: 'n', input: citySchema, needsApproval: false, execute: () => 1 }).approval).toBeUndefined();
    });
});
