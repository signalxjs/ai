/**
 * A tool result in its wire form — the value as it will be after one JSON
 * round trip, so in-process and over-the-wire consumers see one shape:
 * nested `undefined`/function/symbol members are omitted (JSON's encoding of
 * any JS object), a top-level `undefined` is `null`. Or the reason it cannot
 * go on the wire: a BigInt or a cycle (stringify throws), a top-level
 * function/symbol (no JSON form), or a non-finite number anywhere in the
 * graph — `JSON.stringify` would silently turn `NaN`/`Infinity` into `null`,
 * which changes the value.
 */
export function toWireValue(value: unknown): { value: unknown; error?: undefined } | { value?: undefined; error: string } {
    if (value === undefined) return { value: null };
    try {
        const s = JSON.stringify(value, (key, v) => {
            if (typeof v === 'number' && !Number.isFinite(v)) throw new NonFiniteError(key);
            return v;
        });
        if (s === undefined) return { error: `a ${typeof value} has no JSON representation` };
        return { value: JSON.parse(s) };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

class NonFiniteError extends Error {
    constructor(key: string) {
        super(`a non-finite number${key ? ` at "${key}"` : ''} has no JSON representation (it would encode as null)`);
    }
}
