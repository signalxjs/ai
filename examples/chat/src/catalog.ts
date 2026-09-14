/**
 * What the chat playground can run — shared by the server and the browser.
 *
 * Deliberately NOT a `*.server.ts` module: the client build replaces one of
 * those wholesale, and the picker needs these types and this list. Everything
 * here is data — no SDK, no key, nothing that reads the environment.
 *
 * There is no model-listing API in `@sigx/ai` or either provider package
 * (`.model(id)` takes any string), so an example carries its own list. That is
 * the right shape for an example: one place to read, one place to edit.
 */

export const PROVIDERS = ['anthropic', 'openai', 'mock'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export interface ModelChoice {
    readonly id: string;
    readonly label: string;
}

export interface ProviderChoice {
    readonly id: ProviderId;
    readonly label: string;
    readonly models: readonly ModelChoice[];
    /** The key whose presence makes this provider usable; the mock needs none. */
    readonly keyEnv?: string;
}

export const CATALOG: readonly ProviderChoice[] = [
    {
        id: 'anthropic',
        label: 'Anthropic',
        keyEnv: 'ANTHROPIC_API_KEY',
        models: [
            { id: 'claude-opus-5', label: 'Claude Opus 5' },
            { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
            { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }
        ]
    },
    {
        id: 'openai',
        label: 'OpenAI',
        keyEnv: 'OPENAI_API_KEY',
        models: [
            { id: 'gpt-5', label: 'GPT-5' },
            { id: 'gpt-5-mini', label: 'GPT-5 mini' }
        ]
    },
    { id: 'mock', label: 'Scripted mock (no key)', models: [{ id: 'mock-1', label: 'the demo script' }] }
];

export interface Selection {
    readonly provider: ProviderId;
    readonly model: string;
}

/**
 * THE ALLOWLIST. The selection arrives from the browser, so it is
 * attacker-controlled: the server checks it against this before building a
 * model, and the picker renders from the same table. One source, so the two
 * cannot drift into offering something the server would refuse — or, worse,
 * accepting something it never offered.
 */
export function isKnown(selection: Selection): boolean {
    return CATALOG.some((p) => p.id === selection.provider && p.models.some((m) => m.id === selection.model));
}

/** What the catalog endpoint hands the browser: the providers that are actually usable. */
export interface ChatCatalog {
    readonly providers: readonly ProviderChoice[];
    readonly selected: Selection;
}
