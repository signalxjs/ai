import { describe, it, expect } from 'vitest';
import type { VNode } from '@sigx/runtime-core';
import { webComponents, webRegistry, webStyles } from '../../src/web/index.js';
import type { UIComponentProps, UIEvent } from '../../src/app/index.js';

const node = { type: 'x' };
const props = (p: Record<string, unknown>, on: Record<string, (e?: UIEvent) => void> = {}): UIComponentProps => ({ children: [], on, pending: false, node, ...p }) as UIComponentProps;
const vnode = (v: unknown): VNode => v as VNode;

describe('the web pack', () => {
    it('covers every base component', () => {
        expect(Object.keys(webRegistry()).sort()).toEqual(['button', 'card', 'divider', 'image', 'input', 'list', 'stack', 'text']);
        expect(webRegistry({ text: () => null }).text).not.toBe(webComponents.text);
        expect(webStyles).toContain('.ai-ui-button--primary');
    });

    it('stack maps layout props onto flex styles and merges the spec style last', () => {
        const v = vnode(webComponents.stack!(props({ direction: 'row', gap: 8, align: 'center', justify: 'between', wrap: true, padding: 4, style: { gap: '1rem' }, class: 'x' })));
        expect(v.type).toBe('div');
        expect(v.props.class).toBe('ai-ui-stack x');
        expect(v.props.style).toEqual({ display: 'flex', flexDirection: 'row', gap: '1rem', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', padding: '4px' });
    });

    it('text picks its tag from the variant and maps press to onClick only when bound', () => {
        expect(vnode(webComponents.text!(props({ text: 'T', variant: 'heading' }))).type).toBe('h2');
        const plain = vnode(webComponents.text!(props({ text: 'T' })));
        expect(plain.type).toBe('span');
        expect(plain.props.onClick).toBeUndefined();
        const events: UIEvent[] = [];
        const bound = vnode(webComponents.text!(props({ text: 'T' }, { press: (e) => events.push(e!) })));
        (bound.props.onClick as () => void)();
        expect(events).toEqual([{ type: 'press' }]);
    });

    it('button: variant class, disabled while pending, press', () => {
        const v = vnode(webComponents.button!({ ...props({ label: 'Go', variant: 'danger', size: 'sm' }), pending: true }));
        expect(v.type).toBe('button');
        expect(v.props.class).toBe('ai-ui-button ai-ui-button--danger ai-ui-button--sm is-pending');
        expect(v.props.disabled).toBe(true);
    });

    it('input: model value in, input/submit events out with the platform event normalized', () => {
        const set: unknown[] = [];
        const events: UIEvent[] = [];
        const v = vnode(webComponents.input!(props({ placeholder: 'p', kind: 'email', model: { value: 'v', set: (x: unknown) => set.push(x) } }, { input: (e) => events.push(e!), submit: (e) => events.push(e!) })));
        expect(v.type).toBe('input');
        expect(v.props.type).toBe('email');
        expect(v.props.value).toBe('v');
        (v.props.onInput as (e: unknown) => void)({ target: { value: 'w' } });
        (v.props.onKeyDown as (e: unknown) => void)({ key: 'Enter', target: { value: 'w' } });
        (v.props.onKeyDown as (e: unknown) => void)({ key: 'a', target: { value: 'wa' } });
        expect(set).toEqual(['w']);
        expect(events).toEqual([
            { type: 'input', value: 'w' },
            { type: 'submit', value: 'w' }
        ]);
        const labelled = vnode(webComponents.input!(props({ label: 'Name' })));
        expect(labelled.type).toBe('label');
    });

    it('image, card, divider, list', () => {
        const img = vnode(webComponents.image!(props({ src: 'https://x/y.png', alt: 'a', width: 10, fit: 'cover' })));
        expect(img.type).toBe('img');
        expect(img.props.style).toEqual({ objectFit: 'cover', width: '10px' });
        const card = vnode(webComponents.card!(props({ title: 'T', padding: 2 })));
        expect(card.props.style).toEqual({ padding: '2px' });
        expect(card.children).toHaveLength(2);
        expect(vnode(webComponents.divider!(props({}))).type).toBe('hr');
        expect(vnode(webComponents.list!(props({ direction: 'row' }))).props.style).toEqual({ display: 'flex', flexDirection: 'row' });
    });
});
