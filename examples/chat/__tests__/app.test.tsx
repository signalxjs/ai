/**
 * The chat example's picker, in the DOM.
 *
 * The example's first tests, and they earn their place on one contract: what
 * the picker puts on the WIRE. The selection is attacker-controlled, so the
 * server validates it against the catalogue — and the catalogue is also what
 * the picker renders from. Nothing else in the repo checks that those two
 * halves agree, because nothing else has a view.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { component, jsx, defineApp } from 'sigx';
import { CATALOG, isKnown, type ChatCatalog, type Selection } from '../src/catalog';

// `ai.server` builds provider clients and reads keys; the client build
// replaces it with stubs anyway, and `useChat` only ever calls what it is
// given. `chat` is a spy so a test can read what was sent.
const sent: { messages: unknown; selection: Selection }[] = [];
vi.mock('../src/ai.server', () => ({
    chat: (input: { messages: unknown; selection: Selection }) => {
        sent.push(input);
        return (async function* () {})();
    },
    catalog: () => Promise.resolve(fakeCatalog)
}));

const fakeCatalog: ChatCatalog = {
    providers: [
        { id: 'anthropic', label: 'Anthropic', keyEnv: 'ANTHROPIC_API_KEY', models: [{ id: 'claude-opus-5', label: 'Claude Opus 5' }, { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }] },
        { id: 'mock', label: 'Scripted mock (no key)', models: [{ id: 'mock-1', label: 'the demo script' }] }
    ],
    selected: { provider: 'anthropic', model: 'claude-opus-5' }
};

const { App, ModelPicker } = await import('../src/App');

const closers: (() => void)[] = [];
afterEach(() => {
    sent.length = 0;
    for (const close of closers.splice(0).reverse()) close();
});

function mount(node: unknown): HTMLDivElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(node as never).mount(container);
    closers.push(() => {
        app.unmount();
        container.remove();
    });
    return container;
}

/** The DOM settles a tick after mount, once the catalogue promise resolves. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the catalogue', () => {
    it('names no model twice within a provider — an id has to identify one model', () => {
        for (const provider of CATALOG) {
            const ids = provider.models.map((m) => m.id);
            expect(new Set(ids).size).toBe(ids.length);
        }
    });

    it('offers the mock without a key, and every real provider with one', () => {
        const mock = CATALOG.find((p) => p.id === 'mock')!;
        expect(mock.keyEnv).toBeUndefined();
        expect(CATALOG.filter((p) => p.id !== 'mock').every((p) => typeof p.keyEnv === 'string')).toBe(true);
    });

    it('is the allowlist: a pair it does not name is refused', () => {
        expect(isKnown({ provider: 'anthropic', model: 'claude-opus-5' })).toBe(true);
        // A real model, but not this provider's — the pair is what is checked.
        expect(isKnown({ provider: 'openai', model: 'claude-opus-5' })).toBe(false);
        expect(isKnown({ provider: 'anthropic', model: '../../etc/passwd' })).toBe(false);
        expect(isKnown({ provider: 'nope' as never, model: 'gpt-5' })).toBe(false);
    });
});

describe('the model picker', () => {
    const picker = (selection: Selection, onChange: (s: Selection) => void = () => {}, disabled = false) => {
        const One = component(() => () => <ModelPicker catalog={fakeCatalog} selection={selection} disabled={disabled} onChange={onChange} />, { name: 'One' });
        return mount(jsx(One, {}));
    };

    it('renders one option per model of the selected provider', () => {
        const dom = picker({ provider: 'anthropic', model: 'claude-haiku-4-5' });
        const [providers, models] = [...dom.querySelectorAll('select')];
        expect([...providers!.options].map((o) => o.value)).toEqual(['anthropic', 'mock']);
        expect([...models!.options].map((o) => o.value)).toEqual(['claude-opus-5', 'claude-haiku-4-5']);
        expect(models!.value).toBe('claude-haiku-4-5');
    });

    it('carries a model of the new provider when the provider changes — the pair is what the server checks', () => {
        const seen: Selection[] = [];
        const dom = picker({ provider: 'anthropic', model: 'claude-opus-5' }, (s) => seen.push(s));
        const providers = dom.querySelector('select')!;
        providers.value = 'mock';
        providers.dispatchEvent(new Event('change', { bubbles: true }));
        expect(seen).toEqual([{ provider: 'mock', model: 'mock-1' }]);
        expect(isKnown(seen[0]!)).toBe(true);
    });

    it('does not move mid-turn: the reply arriving belongs to the model that started it', () => {
        const dom = picker({ provider: 'anthropic', model: 'claude-opus-5' }, () => {}, true);
        expect([...dom.querySelectorAll('select')].every((s) => s.disabled)).toBe(true);
    });

    it('says so while the catalogue is still loading, rather than rendering an empty dropdown', () => {
        const One = component(() => () => <ModelPicker catalog={undefined} selection={{ provider: 'mock', model: 'mock-1' }} disabled={false} onChange={() => {}} />, { name: 'One' });
        const dom = mount(jsx(One, {}));
        expect(dom.querySelector('select')).toBeNull();
        expect(dom.textContent).toContain('loading');
    });
});

describe('the app', () => {
    it('sends the current selection with the turn', async () => {
        const dom = mount(jsx(App, {}));
        await tick();
        // The server's default replaced the placeholder once the catalogue landed.
        const models = [...dom.querySelectorAll('select')][1]!;
        models.value = 'claude-haiku-4-5';
        models.dispatchEvent(new Event('change', { bubbles: true }));

        const box = dom.querySelector('textarea')!;
        box.value = 'hello';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        dom.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick();

        expect(sent).toHaveLength(1);
        expect(sent[0]!.selection).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
        expect(Array.isArray(sent[0]!.messages)).toBe(true);
    });
});
