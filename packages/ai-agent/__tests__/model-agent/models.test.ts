/** The model catalogue a `modelAgent` session advertises and switches between. */
import { describe, it, expect } from 'vitest';
import { mockModel } from '@sigx/ai/testing';
import { findModel, modelChoices, modelOption } from '../../src/model-agent/models.js';

const a = mockModel({ modelId: 'a' });
const b = mockModel({ modelId: 'b' });

describe('modelChoices', () => {
    it('puts the default first and keeps the given order after it', () => {
        expect(modelChoices(a, [b]).map((m) => m.modelId)).toEqual(['a', 'b']);
    });

    it('is the default alone when no others are given', () => {
        expect(modelChoices(a).map((m) => m.modelId)).toEqual(['a']);
    });

    it('de-duplicates by modelId, first wins — an id must name exactly one model', () => {
        const shadow = mockModel({ modelId: 'a' });
        const choices = modelChoices(a, [shadow, b]);
        expect(choices.map((m) => m.modelId)).toEqual(['a', 'b']);
        expect(choices[0]).toBe(a);
    });
});

describe('modelOption', () => {
    it('labels every value provider/modelId and reports the running one as current', () => {
        expect(modelOption(b, modelChoices(a, [b]))).toEqual({
            id: 'model',
            label: 'Model',
            values: [
                { id: 'a', label: 'mock/a' },
                { id: 'b', label: 'mock/b' }
            ],
            current: 'b'
        });
    });

    it('announces a single choice too — a client shows what is running without offering a switch', () => {
        expect(modelOption(a, modelChoices(a)).values).toEqual([{ id: 'a', label: 'mock/a' }]);
    });
});

describe('findModel', () => {
    it('resolves an id to its model, and nothing to undefined', () => {
        const choices = modelChoices(a, [b]);
        expect(findModel(choices, 'b')).toBe(b);
        expect(findModel(choices, 'nope')).toBeUndefined();
    });
});
