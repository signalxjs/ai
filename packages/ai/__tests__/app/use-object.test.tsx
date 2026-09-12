import { describe, it, expect, afterEach } from 'vitest';
import { component, jsx } from 'sigx';
import { effect } from '@sigx/reactivity';
import { render } from '@sigx/runtime-dom';
import { useObject, type StreamedObject } from '@sigx/ai/app';
import { streamObject, userMessage } from '@sigx/ai';
import { mockModel } from '@sigx/ai/testing';
import { schema } from '../helpers';

type Recipe = { title: string; steps: string[] };
const isRecipe = (v: unknown): v is Recipe => typeof v === 'object' && v !== null && typeof (v as Recipe).title === 'string' && Array.isArray((v as Recipe).steps);
const recipeSchema = schema(isRecipe, { type: 'object', properties: { title: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } }, required: ['title', 'steps'] });

const containers: HTMLDivElement[] = [];
afterEach(() => {
    for (const c of containers.splice(0)) c.remove();
});

function mount(text: string, chunkSize = 6): StreamedObject<Recipe, void> {
    const model = mockModel({ script: [{ text, chunkSize }] });
    let obj!: StreamedObject<Recipe, void>;
    const App = component(() => {
        obj = useObject({ schema: recipeSchema, stream: () => streamObject({ model, schema: recipeSchema, messages: [userMessage('x')] }) });
        return () => <div>{obj.object.title}</div>;
    }, { name: 'App' });
    const c = document.createElement('div');
    containers.push(c);
    render(jsx(App, {}), c);
    return obj;
}

describe('useObject', () => {
    it('reports a stream with no parseable JSON as an error, even without a schema', async () => {
        const model = mockModel({ script: [{ text: 'sorry, no JSON here' }] });
        let obj!: StreamedObject<unknown, void>;
        const App = component(() => {
            obj = useObject({ stream: () => streamObject({ model, schema: recipeSchema, messages: [userMessage('x')] }) });
            return () => <div />;
        }, { name: 'App' });
        const c = document.createElement('div');
        containers.push(c);
        render(jsx(App, {}), c);
        await obj.run();
        expect(obj.status).toBe('error');
        expect(obj.error?.message).toMatch(/no parseable JSON/);
    });

    it('reports a non-object top-level JSON value as an error', async () => {
        const model = mockModel({ script: [{ text: '[1, 2, 3]' }] });
        let obj!: StreamedObject<unknown, void>;
        const App = component(() => {
            obj = useObject({ stream: () => streamObject({ model, schema: recipeSchema, messages: [userMessage('x')] }) });
            return () => <div />;
        }, { name: 'App' });
        const c = document.createElement('div');
        containers.push(c);
        render(jsx(App, {}), c);
        await obj.run();
        expect(obj.status).toBe('error');
        expect(obj.error?.message).toMatch(/expected a JSON object at the top level, got an array/);
    });

    it('grows the partial key by key and validates the final document', async () => {
        const obj = mount('{"title": "Pancakes", "steps": ["mix", "fry"]}');
        expect(obj.status).toBe('idle');
        const titles: (string | undefined)[] = [];
        effect(() => {
            titles.push(obj.object.title);
        });
        await obj.run();
        expect(obj.status).toBe('done');
        expect(obj.object).toEqual({ title: 'Pancakes', steps: ['mix', 'fry'] });
        expect(obj.text).toBe('{"title": "Pancakes", "steps": ["mix", "fry"]}');
        // The title grew through intermediate prefixes and was never regressed.
        expect(titles[0]).toBeUndefined();
        expect(titles[titles.length - 1]).toBe('Pancakes');
        expect(titles.length).toBeGreaterThan(2);
    });

    it('does not rewrite a key whose value did not change', async () => {
        const obj = mount('{"title": "T", "steps": ["a", "b", "c", "d", "e", "f"]}', 4);
        let titleRuns = 0;
        effect(() => {
            obj.object.title;
            titleRuns++;
        });
        await obj.run();
        // initial run + one write when "T" completes; the steps streaming afterwards never touch `title`.
        expect(titleRuns).toBeLessThanOrEqual(3);
        expect(obj.object.steps).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    });

    it('reports a schema failure as error', async () => {
        const obj = mount('{"title": 5}');
        await obj.run();
        expect(obj.status).toBe('error');
        expect(obj.error?.message).toMatch(/did not match the schema/);
    });

    it('reset clears the document', async () => {
        const obj = mount('{"title": "T", "steps": []}');
        await obj.run();
        obj.reset();
        expect(obj.object).toEqual({});
        expect(obj.status).toBe('idle');
        expect(obj.text).toBe('');
    });
});
