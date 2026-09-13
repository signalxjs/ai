/** JSON helpers — the event protocol is plain JSON, so payloads are normalized to their JSON form once. */

/**
 * `JSON.parse(JSON.stringify(value))` with a clear error: `undefined` becomes
 * `null`, dates become strings, and a BigInt or a cycle throws with the
 * package prefix rather than a bare `TypeError` deep inside an event stream.
 */
export function jsonRoundTrip<T = unknown>(value: unknown, what = 'value'): T {
    let text: string | undefined;
    try {
        text = JSON.stringify(value);
    } catch (e) {
        throw new Error(`[sigx ai-agent] ${what} is not JSON-serializable: ${e instanceof Error ? e.message : String(e)}`);
    }
    return (text === undefined ? null : JSON.parse(text)) as T;
}

/** Structural deep equality on JSON-compatible values (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
        return true;
    }
    const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
}
