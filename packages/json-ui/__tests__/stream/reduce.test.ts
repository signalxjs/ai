import { describe, it, expect } from 'vitest';
import { signal, toRaw } from '@sigx/reactivity';
import { applyPatch, applyUIChunk, assembleSpec, baseCatalog, createDocument, type UIDocument, type UISpec, type UIStreamChunk } from '../../src/index.js';

const spec: UISpec = {
    version: 1,
    state: { count: 0 },
    root: { type: 'stack', children: [{ type: 'text', id: 't', props: { text: '{{count}}' } }, { type: 'button', id: 'b', props: { label: 'Add' }, on: { press: [{ do: 'state.set', path: 'count', value: { $: 'count + 1' } }] } }] }
};

function chunked(text: string, size: number): UIStreamChunk[] {
    const out: UIStreamChunk[] = [];
    for (let i = 0; i < text.length; i += size) out.push({ type: 'text', delta: text.slice(i, i + size) });
    out.push({ type: 'finish' });
    return out;
}

describe('applyUIChunk', () => {
    it('folds text deltas into a growing spec, keeps identities, and validates at finish', () => {
        const doc = signal(createDocument()) as UIDocument;
        const chunks = chunked(JSON.stringify(spec), 7);
        let textRaw: object | undefined;
        for (const chunk of chunks) {
            const ended = applyUIChunk(doc, chunk, { catalog: baseCatalog });
            const first = doc.spec.root?.children?.[0];
            if (first && !textRaw) textRaw = toRaw(first);
            if (chunk.type === 'text') expect(doc.status).toBe('streaming');
            if (ended) expect(chunk.type).toBe('finish');
        }
        expect(doc.status).toBe('done');
        expect(doc.issues).toEqual([]);
        expect(toRaw(doc.spec)).toEqual(spec);
        expect(toRaw(doc.spec.root!.children![0])).toBe(textRaw);
    });

    it('works on a plain document too (server side)', async () => {
        const doc = createDocument();
        async function* source(): AsyncGenerator<UIStreamChunk> {
            for (const c of chunked(JSON.stringify(spec), 11)) yield c;
        }
        await assembleSpec(source(), doc, { catalog: baseCatalog });
        expect(doc.spec).toEqual(spec);
        expect(doc.status).toBe('done');
    });

    it('spec chunks merge pre-parsed partials (the tool path)', () => {
        const doc = createDocument();
        applyUIChunk(doc, { type: 'spec', spec: { root: { type: 'text', props: { text: 'He' } } } });
        expect(doc.status).toBe('streaming');
        applyUIChunk(doc, { type: 'spec', spec: { root: { type: 'text', props: { text: 'Hello' } } } });
        expect(doc.spec.root?.props?.text).toBe('Hello');
        expect(applyUIChunk(doc, { type: 'finish' }, { catalog: baseCatalog })).toBe(true);
        expect(doc.status).toBe('done');
    });

    it('reports validation issues at finish and keeps the partial spec', () => {
        const doc = createDocument();
        applyUIChunk(doc, { type: 'text', delta: '{"root": {"type": "nope", "props": {"x": 1}' });
        applyUIChunk(doc, { type: 'finish' }, { catalog: baseCatalog });
        expect(doc.status).toBe('done');
        expect(doc.spec.root?.type).toBe('nope');
        expect(doc.issues.map((i) => i.message)).toContain('unknown component "nope"');
    });

    it('error chunks end the stream', () => {
        const doc = createDocument();
        expect(applyUIChunk(doc, { type: 'error', message: 'boom' })).toBe(true);
        expect(doc.status).toBe('error');
        expect(doc.error).toBe('boom');
    });

    it('patch chunks change nodes by id; an unknown id is an issue, not a throw', () => {
        const doc = createDocument(JSON.parse(JSON.stringify(spec)) as UISpec);
        applyUIChunk(doc, {
            type: 'patch',
            patches: [
                { op: 'props', id: 'b', props: { label: 'Plus' } },
                { op: 'append', id: 'b', node: { type: 'divider' } },
                { op: 'replace', id: 't', node: { type: 'text', id: 't', props: { text: 'n' } } },
                { op: 'remove', id: 'missing' },
                { op: 'state', path: 'count', value: 5 }
            ]
        });
        expect(doc.spec.root?.children?.[1]?.props?.label).toBe('Plus');
        expect(doc.spec.root?.children?.[1]?.children?.[0]?.type).toBe('divider');
        expect(doc.spec.root?.children?.[0]?.props?.text).toBe('n');
        expect(doc.spec.state?.count).toBe(5);
        expect(doc.issues).toHaveLength(1);
        expect(doc.issues[0]?.message).toMatch(/missing/);
        applyUIChunk(doc, { type: 'patch', patches: [{ op: 'remove', id: 't' }] });
        expect(doc.spec.root?.children?.map((c) => c.id)).toEqual(['b']);
    });

    it('state patches land in the runtime state when one is given', () => {
        const state: Record<string, unknown> = {};
        const s: UISpec = { root: { type: 'text', props: { text: '' } } };
        expect(applyPatch(s, { op: 'state', path: 'form.name', value: 'x' }, state)).toBeUndefined();
        expect(state).toEqual({ form: { name: 'x' } });
        expect(applyPatch(s, { op: 'state', path: '$set', value: 1 }, state)?.severity).toBe('error');
    });
});
