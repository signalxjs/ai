// A fake harness: NDJSON JSON-RPC on stdio. `echo` returns its params, `big`
// returns a large string, `utf8` returns multi-byte text, `fail` exits with a
// code after writing to stderr, `ping` sends a request to the client first.
import { createInterface } from 'node:readline';

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
let nextId = 1000;
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.id === undefined) return; // notification
    if (msg.result !== undefined || msg.error !== undefined) return; // a response to our own request
    switch (msg.method) {
        case 'echo':
            out({ jsonrpc: '2.0', id: msg.id, result: msg.params });
            break;
        case 'big':
            out({ jsonrpc: '2.0', id: msg.id, result: 'x'.repeat(msg.params.bytes) });
            break;
        case 'utf8':
            out({ jsonrpc: '2.0', id: msg.id, result: 'héllo wörld — 日本語 🚀'.repeat(msg.params?.times ?? 1) });
            break;
        case 'env':
            out({ jsonrpc: '2.0', id: msg.id, result: process.env });
            break;
        case 'ping':
            out({ jsonrpc: '2.0', id: nextId++, method: 'client/ping', params: { from: 'fixture' } });
            out({ jsonrpc: '2.0', id: msg.id, result: 'pinged' });
            break;
        case 'fail':
            process.stderr.write(msg.params.message + '\n', () => process.exit(msg.params.code));
            break;
        default:
            out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
    }
});
rl.on('close', () => process.exit(0));
