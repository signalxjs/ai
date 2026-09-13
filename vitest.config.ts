import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const __dirname = import.meta.dirname;

export default defineConfig({
    // `__DEV__` is the compile-time dev flag package sources guard on; the build
    // (vite.config.ts) replaces it in the dists, so tests must define it too.
    define: {
        __DEV__: 'true'
    },
    oxc: {
        jsx: {
            runtime: 'automatic',
            importSource: 'sigx'
        }
    },
    test: {
        environment: 'happy-dom',
        include: ['packages/**/__tests__/**/*.test.{ts,tsx}'],
        exclude: ['**/node_modules/**'],
        globals: true,
        typecheck: {
            enabled: true,
            include: ['packages/**/__tests__/**/*.test-d.ts']
        }
    },
    resolve: {
        // Subpaths before the bare name: vitest matches aliases in order and a
        // bare `@sigx/ai` entry first would swallow `@sigx/ai/app`.
        alias: [
            // `@sigx/ai-agent` subpaths first, then the bare name as a regex: a
            // string `find` is a prefix match and would swallow `@sigx/ai-agent-node`.
            { find: '@sigx/ai-agent/testing', replacement: resolve(__dirname, 'packages/ai-agent/src/testing/index.ts') },
            { find: '@sigx/ai-agent/coding', replacement: resolve(__dirname, 'packages/ai-agent/src/coding/index.ts') },
            { find: '@sigx/ai-agent/harness', replacement: resolve(__dirname, 'packages/ai-agent/src/harness/index.ts') },
            { find: /^@sigx\/ai-agent$/, replacement: resolve(__dirname, 'packages/ai-agent/src/index.ts') },
            { find: '@sigx/ai/server', replacement: resolve(__dirname, 'packages/ai/src/server/index.ts') },
            { find: '@sigx/ai/app', replacement: resolve(__dirname, 'packages/ai/src/app/index.ts') },
            { find: '@sigx/ai/testing', replacement: resolve(__dirname, 'packages/ai/src/testing/index.ts') },
            { find: '@sigx/ai-anthropic', replacement: resolve(__dirname, 'packages/ai-anthropic/src/index.ts') },
            { find: '@sigx/ai-openai', replacement: resolve(__dirname, 'packages/ai-openai/src/index.ts') },
            { find: /^@sigx\/ai$/, replacement: resolve(__dirname, 'packages/ai/src/index.ts') }
        ]
    }
});
