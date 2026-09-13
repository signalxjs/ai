/**
 * `__DEV__` — the compile-time dev flag. `false` in the prod dist (blocks are
 * stripped), a runtime NODE_ENV check in the dev dist, `true` under vitest.
 * Defined by `defineLibConfig` (build) and `vitest.config.ts` (tests).
 */
declare const __DEV__: boolean;
