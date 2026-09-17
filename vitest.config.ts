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
        // The examples are shipped code too, and the agent example's view is
        // the only place its render decisions live — an empty box under a
        // tool that returned nothing (#128) is a bug no package test can see.
        include: ['packages/**/__tests__/**/*.test.{ts,tsx}', 'examples/*/__tests__/**/*.test.{ts,tsx}'],
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
            { find: '@sigx/ai-agent/wire', replacement: resolve(__dirname, 'packages/ai-agent/src/wire/index.ts') },
            { find: '@sigx/ai-agent/app', replacement: resolve(__dirname, 'packages/ai-agent/src/app/index.ts') },
            { find: '@sigx/ai-agent-node', replacement: resolve(__dirname, 'packages/ai-agent-node/src/index.ts') },
            { find: '@sigx/ai-agent-acp', replacement: resolve(__dirname, 'packages/ai-agent-acp/src/index.ts') },
            { find: '@sigx/ai-agent-claude-code', replacement: resolve(__dirname, 'packages/ai-agent-claude-code/src/index.ts') },
            { find: '@sigx/ai-agent-codex', replacement: resolve(__dirname, 'packages/ai-agent-codex/src/index.ts') },
            { find: '@sigx/ai-agent-copilot', replacement: resolve(__dirname, 'packages/ai-agent-copilot/src/index.ts') },
            { find: /^@sigx\/ai-agent$/, replacement: resolve(__dirname, 'packages/ai-agent/src/index.ts') },
            { find: '@sigx/ai/server', replacement: resolve(__dirname, 'packages/ai/src/server/index.ts') },
            { find: '@sigx/ai/app', replacement: resolve(__dirname, 'packages/ai/src/app/index.ts') },
            { find: '@sigx/ai/testing', replacement: resolve(__dirname, 'packages/ai/src/testing/index.ts') },
            { find: '@sigx/ai/ui', replacement: resolve(__dirname, 'packages/ai/src/ui/index.ts') },
            { find: '@sigx/ai-anthropic', replacement: resolve(__dirname, 'packages/ai-anthropic/src/index.ts') },
            { find: '@sigx/ai-openai', replacement: resolve(__dirname, 'packages/ai-openai/src/index.ts') },
            { find: '@sigx/json-ui/app', replacement: resolve(__dirname, 'packages/json-ui/src/app/index.ts') },
            { find: '@sigx/json-ui/web', replacement: resolve(__dirname, 'packages/json-ui/src/web/index.ts') },
            { find: /^@sigx\/json-ui$/, replacement: resolve(__dirname, 'packages/json-ui/src/index.ts') },
            { find: /^@sigx\/ai$/, replacement: resolve(__dirname, 'packages/ai/src/index.ts') }
        ]
    }
});
