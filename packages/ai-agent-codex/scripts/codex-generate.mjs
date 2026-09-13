#!/usr/bin/env node
/**
 * Regenerate the Codex app-server TypeScript types into `generated/` with the
 * installed Codex CLI (`codex app-server generate-ts --experimental`). The
 * adapter itself ships a hand-written subset in `src/schema.ts`; this output
 * is for diffing that subset against the CLI version you run — nothing here
 * is imported at runtime.
 *
 * Usage: pnpm --filter @sigx/ai-agent-codex codex:generate [--out <dir>]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { resolveExecutable, spawnAgentProcess } from '@sigx/ai-agent-node';

const here = dirname(fileURLToPath(import.meta.url));
const outIndex = process.argv.indexOf('--out');
const out = outIndex !== -1 && process.argv[outIndex + 1] ? process.argv[outIndex + 1] : join(here, '..', 'generated');

let exe;
try {
    exe = await resolveExecutable('codex');
} catch (e) {
    console.log(`codex:generate skipped — no codex executable on PATH (${e instanceof Error ? e.message : String(e)})`);
    process.exit(0);
}

mkdirSync(out, { recursive: true });
const proc = spawnAgentProcess({ command: exe.command, args: [...exe.args, 'app-server', 'generate-ts', '--experimental', '--out', out], env: exe.env, kind: exe.kind, inheritEnv: true });
const exit = await proc.exited;
if (exit.code !== 0) {
    console.error(`codex app-server generate-ts failed (exit ${exit.code ?? exit.signal})\n${exit.stderrTail}`);
    process.exit(1);
}
console.log(`Generated Codex app-server types into ${out}`);
