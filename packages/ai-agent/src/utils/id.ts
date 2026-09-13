/** Id generation — random when the runtime offers it, a counter otherwise (tests, exotic runtimes). */

let counter = 0;

/** `${prefix}_<12 random chars>`; edge-safe (`crypto.randomUUID`, no `node:`). */
export function generateId(prefix = 'id'): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return `${prefix}_${c.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    return `${prefix}_${(++counter).toString(36).padStart(6, '0')}`;
}
