// Spawns a grandchild that idles, prints both pids, and idles itself — for
// kill-tree tests. Neither process exits on its own.
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.stdout.write(JSON.stringify({ pid: process.pid, child: child.pid }) + '\n');
setInterval(() => {}, 1000);
