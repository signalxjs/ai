import { defineLibConfig } from '@sigx/vite/lib';
import type { ConfigEnv, UserConfig } from 'vite';

// Same two-pass build as the sibling packages: dev dist + prod dist with
// __DEV__ stripped; `.d.ts` from `tsc --emitDeclarationOnly`. The Agent SDK
// is a peer and `@sigx/*` are peers/dependencies — external, never bundled.
const base = defineLibConfig({
    entry: {
        index: 'src/index.ts'
    },
    external: [/@sigx\/.*/, /^node:/, /^@anthropic-ai\//],
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
