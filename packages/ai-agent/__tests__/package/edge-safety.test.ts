/**
 * The edge guard, as a test: `@sigx/ai-agent` must run on workerd, Deno, Bun
 * and browsers, so its sources may not import `node:` modules or touch the
 * `process` / `Buffer` globals. The `tsconfig` `types: []` catches most of it
 * at declaration time; this scan catches the rest (dynamic imports, string
 * module ids, a `typeof process` that would still be a Node assumption).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const src = join(root, 'src');

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
    }
    return out;
}

/** Drop comments and string/template literals so prose and messages don't trip the scan. */
function codeOnly(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
        .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
        .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

const FORBIDDEN: { pattern: RegExp; why: string }[] = [
    { pattern: /from\s*['"]node:/, why: 'node: import' },
    { pattern: /import\(\s*['"]node:/, why: 'dynamic node: import' },
    { pattern: /\brequire\s*\(/, why: 'require()' },
    { pattern: /\bprocess\b/, why: 'process global' },
    { pattern: /\bBuffer\b/, why: 'Buffer global' }
];

describe('@sigx/ai-agent edge safety', () => {
    it('sources import nothing from node: and never touch process or Buffer', () => {
        const offences: string[] = [];
        for (const file of walk(src)) {
            const raw = readFileSync(file, 'utf8');
            // Module ids are string literals — check them before stripping strings.
            raw.split('\n').forEach((line, i) => {
                if (/from\s*['"]node:|import\(\s*['"]node:/.test(line)) offences.push(`${relative(root, file)}:${i + 1}: node: import`);
            });
            codeOnly(raw)
                .split('\n')
                .forEach((line, i) => {
                    for (const { pattern, why } of FORBIDDEN.slice(2)) {
                        if (pattern.test(line)) offences.push(`${relative(root, file)}:${i + 1}: ${why}`);
                    }
                });
        }
        expect(offences).toEqual([]);
    });

    it('the package tsconfig keeps the no-Node-types guard', () => {
        const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8').replace(/\/\/[^\n]*/g, '')) as { compilerOptions: { types?: string[] } };
        expect(tsconfig.compilerOptions.types).toEqual([]);
    });

    it('the package declares no runtime dependencies', () => {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
        expect(pkg.dependencies ?? {}).toEqual({});
    });
});
