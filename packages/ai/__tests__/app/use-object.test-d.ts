/**
 * Typing contract for `useObject`: the document (and `onFinish`) are typed
 * by the schema when one is given, and `unknown` when none is — a caller
 * cannot claim a type it never validated.
 */
import { describe, it, expectTypeOf } from 'vitest';
import { useObject, type StreamedObject } from '@sigx/ai/app';
import type { StandardSchemaV1, UIChunk } from '@sigx/ai';

type Recipe = { title: string; steps: string[] };
declare const recipeSchema: StandardSchemaV1<Recipe, Recipe>;
declare const stream: () => AsyncIterable<UIChunk>;

describe('useObject typing', () => {
    it('types the document by the schema', () => {
        const typed = () => useObject({ schema: recipeSchema, stream, onFinish: (o) => expectTypeOf(o).toEqualTypeOf<Recipe>() });
        expectTypeOf(typed).returns.toEqualTypeOf<StreamedObject<Recipe, void>>();
    });

    it('is unknown without a schema', () => {
        const untyped = () => useObject({ stream, onFinish: (o) => expectTypeOf(o).toEqualTypeOf<unknown>() });
        expectTypeOf(untyped).returns.toEqualTypeOf<StreamedObject<unknown, void>>();
    });
});
