/**
 * An in-memory `codex app-server`: a JSON-RPC peer over two TransformStream
 * pairs that answers the handshake, threads and `turn/start`, then runs a
 * scripted turn program — notifications and server→client requests in the
 * order a recording showed them — and honours `turn/interrupt`.
 */
import { createJsonRpcPeer, type JsonRpcPeer, type RequestContext } from '@sigx/ai-agent/harness';
import type { CodexTransport } from '@sigx/ai-agent-codex';
import type { ThreadStartResponse, Turn, UserInput } from '../src/schema';

export interface TurnProgramContext {
    readonly threadId: string;
    readonly turnId: string;
    readonly input: readonly UserInput[];
    readonly params: Record<string, unknown>;
    /** Resolves when the client interrupts this turn. */
    readonly interrupted: Promise<void>;
    readonly isInterrupted: () => boolean;
    notify(method: string, params: unknown): Promise<void>;
    request<R = unknown>(method: string, params: unknown): Promise<R>;
    /** `item/started` + `item/completed` helpers keep programs short. */
    item(item: Record<string, unknown>, phase: 'started' | 'completed'): Promise<void>;
    complete(status?: Turn['status'], error?: Turn['error']): Promise<void>;
}

export type TurnProgram = (ctx: TurnProgramContext) => Promise<void>;

export interface FakeAppServerOptions {
    readonly onTurn: TurnProgram;
    /** `account/read` result; `null` account = not signed in; `'missing'` = method unknown. */
    readonly account?: { readonly type: string } | null | 'missing';
    readonly authStatus?: { authMethod: string | null; authToken: string | null; requiresOpenaiAuth: boolean | null };
    readonly models?: readonly { id: string; model: string; displayName: string; hidden: boolean }[];
    readonly threadId?: string;
    /** Fields merged over the default `thread/start` response (an unusual approval policy or sandbox). */
    readonly thread?: Partial<Omit<ThreadStartResponse, 'thread'>>;
}

export interface FakeAppServer {
    readonly transport: CodexTransport;
    readonly peer: JsonRpcPeer;
    /** Every client→server request, in order. */
    readonly requests: { method: string; params: unknown }[];
    readonly threads: { method: string; params: unknown; id: string }[];
    close(): Promise<void>;
}

let ids = 0;

export function fakeAppServer(options: FakeAppServerOptions): FakeAppServer {
    const c2s = new TransformStream<Uint8Array, Uint8Array>();
    const s2c = new TransformStream<Uint8Array, Uint8Array>();
    const peer = createJsonRpcPeer({ readable: c2s.readable, writable: s2c.writable, cancelMethod: null });
    const requests: { method: string; params: unknown }[] = [];
    const threads: { method: string; params: unknown; id: string }[] = [];
    const interrupts = new Map<string, () => void>();
    const record = (method: string) => (params: unknown) => {
        requests.push({ method, params });
        return params;
    };

    peer.onRequest('initialize', (p) => {
        record('initialize')(p);
        return { userAgent: 'fake-codex/0.153.4', codexHome: '/home/x/.codex', platformFamily: 'unix', platformOs: 'linux' };
    });
    peer.onNotification('initialized', record('initialized'));
    peer.onRequest('account/read', (p) => {
        record('account/read')(p);
        if (options.account === 'missing') throw Object.assign(new Error('Method not found'), { code: -32601 });
        return { account: options.account === undefined ? { type: 'apiKey' } : options.account };
    });
    peer.onRequest('getAuthStatus', (p) => {
        record('getAuthStatus')(p);
        return options.authStatus ?? { authMethod: 'apikey', authToken: null, requiresOpenaiAuth: true };
    });
    peer.onRequest('model/list', (p) => {
        record('model/list')(p);
        return { data: options.models ?? [{ id: 'gpt-5', model: 'gpt-5', displayName: 'GPT-5', hidden: false }], nextCursor: null };
    });
    const threadResponse = (id: string, params: Record<string, unknown>): ThreadStartResponse => ({
        thread: { id, preview: '', model: (params.model as string) ?? 'gpt-5', reasoningEffort: 'medium' },
        model: (params.model as string) ?? 'gpt-5',
        approvalPolicy: (params.approvalPolicy as 'untrusted') ?? 'on-request',
        sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        reasoningEffort: 'medium',
        ...options.thread
    });
    for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
        peer.onRequest(method, (p: Record<string, unknown>) => {
            record(method)(p);
            const id = method === 'thread/resume' ? (p.threadId as string) : method === 'thread/fork' ? `${String(p.threadId)}-fork` : (options.threadId ?? `thread_${++ids}`);
            threads.push({ method, params: p, id });
            return threadResponse(id, p);
        });
    }
    peer.onRequest('thread/list', (p) => {
        record('thread/list')(p);
        return { data: [{ id: 'thread_a', preview: 'First thread', model: 'gpt-5', reasoningEffort: null, cwd: '/repo' }], nextCursor: null };
    });
    peer.onRequest('turn/interrupt', (p: { threadId: string; turnId: string }) => {
        record('turn/interrupt')(p);
        interrupts.get(p.turnId)?.();
        return {};
    });
    peer.onRequest('turn/start', (p: Record<string, unknown>, _ctx: RequestContext) => {
        record('turn/start')(p);
        const threadId = p.threadId as string;
        const turnId = `turn_${++ids}`;
        let interruptedFlag = false;
        let fire!: () => void;
        const interrupted = new Promise<void>((resolve) => {
            fire = () => {
                interruptedFlag = true;
                resolve();
            };
        });
        interrupts.set(turnId, fire);
        const ctx: TurnProgramContext = {
            threadId,
            turnId,
            input: p.input as UserInput[],
            params: p,
            interrupted,
            isInterrupted: () => interruptedFlag,
            notify: (method, params) => peer.notify(method, params),
            request: (method, params) => peer.request(method, params),
            item: (item, phase) => peer.notify(phase === 'started' ? 'item/started' : 'item/completed', { item, threadId, turnId }),
            complete: (status = 'completed', error = null) => peer.notify('turn/completed', { threadId, turn: { id: turnId, status, error, items: [] } })
        };
        // The response goes out first; the program runs on the next tick.
        setTimeout(() => {
            void peer.notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', error: null } }).then(() => options.onTurn(ctx)).catch(() => {});
        }, 0);
        return { turn: { id: turnId, status: 'inProgress', error: null } };
    });

    return {
        transport: { readable: s2c.readable, writable: c2s.writable },
        peer,
        requests,
        threads,
        close: () => peer.close()
    };
}

/** A program that streams `text` as an agent message and ends the turn. */
export const say =
    (text: string): TurnProgram =>
    async (ctx) => {
        const id = `msg_${++ids}`;
        await ctx.item({ type: 'agentMessage', id, text: '' }, 'started');
        for (const word of text.match(/\S*\s|\S+$/g) ?? [text]) await ctx.notify('item/agentMessage/delta', { threadId: ctx.threadId, turnId: ctx.turnId, itemId: id, delta: word });
        await ctx.item({ type: 'agentMessage', id, text }, 'completed');
        await ctx.complete();
    };
