/**
 * The models a `modelAgent` session can be switched between.
 *
 * A `LanguageModel` already says what it is — `provider` and `modelId` — so a
 * plain array is the whole catalogue: no registry, no resolver, no new type
 * for callers to learn. `.model(id)` on a provider is a small object literal
 * over one shared SDK client, so naming three models costs one client and
 * three literals; there is nothing here worth making lazy.
 */

import type { LanguageModel } from '@sigx/ai';
import type { ConfigOption } from '../protocol/index.js';

/** The agent's default model first, then the rest, one entry per `modelId`. */
export function modelChoices(fallback: LanguageModel, models: readonly LanguageModel[] = []): readonly LanguageModel[] {
    const out: LanguageModel[] = [fallback];
    // First wins: two providers offering the same `modelId` would otherwise
    // give `configure()` an id it cannot resolve to one model.
    for (const model of models) if (!out.some((m) => m.modelId === model.modelId)) out.push(model);
    return out;
}

export function findModel(choices: readonly LanguageModel[], id: string): LanguageModel | undefined {
    return choices.find((m) => m.modelId === id);
}

/**
 * What the session advertises. A single choice is still announced: a client
 * then shows which model is running without offering a switch, the same way a
 * harness reports a model it cannot change.
 */
export function modelOption(current: LanguageModel, choices: readonly LanguageModel[]): ConfigOption {
    return {
        id: 'model',
        label: 'Model',
        values: choices.map((m) => ({ id: m.modelId, label: `${m.provider}/${m.modelId}` })),
        current: current.modelId
    };
}
