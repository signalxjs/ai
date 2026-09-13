/**
 * Session-scoped permission grants — `scope: 'session'` decisions, keyed by
 * the adapter's `permissionKey`. Memory only: a grant never reaches a harness
 * settings file, and it dies with the session.
 */

export interface SessionGrants {
    has(permissionKey: string): boolean;
    add(permissionKey: string): void;
    delete(permissionKey: string): boolean;
    clear(): void;
    keys(): string[];
}

export function createGrants(initial?: Iterable<string>): SessionGrants {
    const set = new Set<string>(initial);
    return {
        has: (key) => set.has(key),
        add: (key) => {
            set.add(key);
        },
        delete: (key) => set.delete(key),
        clear: () => set.clear(),
        keys: () => [...set]
    };
}
