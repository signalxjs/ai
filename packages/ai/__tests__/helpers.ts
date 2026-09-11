/**
 * Shared test helpers: a dependency-free Standard Schema factory and a
 * chunk collector.
 */
import type { StandardSchemaV1, JsonSchema, UIChunk } from '@sigx/ai';

/** A Standard Schema from a predicate + a JSON Schema — what Zod would give us. */
export function schema<T>(
    check: (value: unknown) => value is T,
    jsonSchema: JsonSchema,
    message = 'invalid'
): StandardSchemaV1<T, T> {
    return {
        '~standard': {
            version: 1,
            vendor: 'test',
            validate: (value) => (check(value) ? { value } : { issues: [{ message }] }),
            jsonSchema: { input: () => jsonSchema, output: () => jsonSchema }
        }
    };
}

/** A schema WITHOUT the Standard JSON Schema hook. */
export function bareSchema<T>(check: (value: unknown) => value is T): StandardSchemaV1<T, T> {
    return {
        '~standard': {
            version: 1,
            vendor: 'test',
            validate: (value) => (check(value) ? { value } : { issues: [{ message: 'invalid' }] })
        }
    };
}

export const isCity = (v: unknown): v is { city: string } =>
    typeof v === 'object' && v !== null && typeof (v as { city?: unknown }).city === 'string';

export const citySchema = schema(isCity, { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false });

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
}

export function textOf(chunks: UIChunk[]): string {
    return chunks.filter((c): c is Extract<UIChunk, { type: 'text' }> => c.type === 'text').map((c) => c.delta).join('');
}

export function tick(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0));
}
