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
 * attacker-controlled: the server checks it before building a model, and the
 * picker renders from the same table. One source, so the two cannot drift into
 * offering something the server would refuse — or, worse, accepting something
 * it never offered.
 *
 * The server passes the providers it can actually SERVE, not the whole
 * catalogue: a pair naming a provider whose key is missing is a request this
 * server cannot honour, and it should be refused as a bad request rather than
 * fail when the SDK client is built. The UI hiding those providers is not a
 * check — nothing stops a client posting one anyway.
 */
export function isOffered(usable: readonly ProviderChoice[], selection: Selection): boolean {
    return usable.some((p) => p.id === selection.provider && p.models.some((m) => m.id === selection.model));
}

/** `isOffered` over the whole catalogue — "is this a pair that exists at all". */
export function isKnown(selection: Selection): boolean {
    return isOffered(CATALOG, selection);
}

/**
 * What the picker starts on, given the providers that are actually usable.
 *
 * Pure, so it can be tested without the environment. The rule it enforces:
 * **the default must be one of the offered providers.** A requested provider
 * whose key is missing is not offered, and handing the picker a selection that
 * is not in its own list would produce a request the server refuses — exactly
 * what filtering the list was meant to prevent.
 */
export function defaultFor(usable: readonly ProviderChoice[], wanted: ProviderId | undefined, wantedModel: string | undefined): { selection: Selection; warning?: string } {
    const asked = wanted !== undefined ? usable.find((p) => p.id === wanted) : undefined;
    // `mock` needs no key, so there is always something left to fall back to.
    const entry = asked ?? usable.find((p) => p.id === 'mock') ?? usable[0];
    if (!entry) throw new Error('[chat] no provider is available, not even the mock');
    const model = wantedModel && entry.models.some((m) => m.id === wantedModel) ? wantedModel : entry.models[0]!.id;
    const warnings = [
        wanted !== undefined && !asked ? `SIGX_AI_PROVIDER=${wanted} has no key set — starting on ${entry.label}.` : undefined,
        wantedModel && model !== wantedModel && asked ? `SIGX_AI_MODEL=${wantedModel} is not one of ${entry.label}'s models — using ${model}.` : undefined
    ].filter(Boolean);
    return { selection: { provider: entry.id, model }, ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
}

/** What the catalog endpoint hands the browser: the providers that are actually usable. */
export interface ChatCatalog {
    readonly providers: readonly ProviderChoice[];
    readonly selected: Selection;
}
