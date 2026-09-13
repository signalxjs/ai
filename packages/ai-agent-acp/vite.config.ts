import { defineLibConfig } from '@sigx/vite/lib';
import type { ConfigEnv, UserConfig } from 'vite';

// Same two-pass build as the sibling packages: dev dist + prod dist with
// __DEV__ stripped; `.d.ts` from `tsc --emitDeclarationOnly`. Node-only (the
// stdio path spawns the agent), so `node:` modules stay external.
const base = defineLibConfig({
    entry: {
        index: 'src/index.ts'
    },
    external: [/@sigx\/.*/, /^node:/],
    platform: 'node',
    root: import.meta.url
}) as (env: ConfigEnv) => UserConfig;

export default (env: ConfigEnv): UserConfig => {
    const config = base(env);
    if (env.mode !== 'prod-dist') {
        config.define = {
            ...config.define,
            __DEV__: "(typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')"
        };
    }
    return config;
};
