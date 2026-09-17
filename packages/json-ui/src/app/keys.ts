/**
 * Identity keys for reconciliation. Not the node's `id`: that streams in
 * character by character and may arrive after `children`, so keying on it
 * would remount the node on every token. The raw object behind the proxy is
 * stable from the moment the merge creates it, so a key handed out per raw
 * object is stable for the node's whole life.
 */

const keys = new WeakMap<object, string>();
let seq = 0;

export function keyOf(raw: object): string {
    let key = keys.get(raw);
    if (!key) {
        key = `n${(++seq).toString(36)}`;
        keys.set(raw, key);
    }
    return key;
}
