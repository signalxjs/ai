import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, jsx } from 'sigx';
import { render } from '@sigx/runtime-dom';
import { useCompletion, type Completion } from '@sigx/ai/app';
import { chatStream } from '@sigx/ai/server';
import { mockModel } from '@sigx/ai/testing';
import { userMessage } from '@sigx/ai';

const containers: HTMLDivElement[] = [];
afterEach(() => {
    for (const c of containers.splice(0)) c.remove();
    delete (globalThis as any).__SIGX_ASYNC__;
});

function mount(key: string, source: () => AsyncIterable<any>): { completion: Completion; container: HTMLDivElement } {
    let completion!: Completion;
    const App = component(() => {
        completion = useCompletion(key, source);
        return () => <p class="out">{completion.text}</p>;
    }, { name: 'App' });
    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);
    render(jsx(App, {}), container);
    return { completion, container };
}

describe('useCompletion', () => {
    it('streams text live on the client and reports reasoning and status', async () => {
        const model = mockModel({ script: [{ reasoning: 'hmm', text: 'The answer is 42' }] });
        const { completion, container } = mount('live', () => chatStream({ model, messages: [userMessage('q')] }));
        await vi.waitFor(() => {
            expect(container.querySelector('.out')?.textContent).toBe('The answer is 42');
        });
        await vi.waitFor(() => expect(completion.status).toBe('done'));
        expect(completion.reasoning).toBe('hmm');
        expect(completion.error).toBeNull();
    });

    it('restores a hydrated answer without running the source', async () => {
        (globalThis as any).__SIGX_ASYNC__ = { restored: 'from the server' };
        const source = vi.fn(() => chatStream({ model: mockModel(), messages: [userMessage('q')] }));
        const { completion, container } = mount('restored', source);
        expect(container.querySelector('.out')?.textContent).toBe('from the server');
        expect(source).not.toHaveBeenCalled();
        expect(completion.status).toBe('done');
    });

    it('accepts a plain string stream', async () => {
        async function* words() {
            yield 'a ';
            yield 'b';
        }
        const { container } = mount('plain', words);
        await vi.waitFor(() => expect(container.querySelector('.out')?.textContent).toBe('a b'));
    });

    it('normalizes a non-Error throw into the same Error it exposes', async () => {
        async function* bad(): AsyncGenerator<string> {
            yield 'x';
            throw 'plain string';
        }
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { completion } = mount('non-error', bad);
        await vi.waitFor(() => expect(completion.status).toBe('error'));
        expect(completion.error).toBeInstanceOf(Error);
        expect(completion.error?.message).toBe('plain string');
        // useStream logs the rejection it saw — the very object completion.error holds.
        expect(spy).toHaveBeenCalledWith('[useStream] source error:', completion.error);
        spy.mockRestore();
    });

    it('reports an error chunk', async () => {
        const model = mockModel({ script: [{ text: 'x', error: 'nope' }] });
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { completion } = mount('err', () => chatStream({ model, messages: [userMessage('q')] }));
        await vi.waitFor(() => expect(completion.status).toBe('error'));
        expect(completion.error?.message).toBe('nope');
        spy.mockRestore();
    });
});
