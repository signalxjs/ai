/**
 * The built-in actions. Each is an `ActionHandler`: arguments already
 * resolved (except the lazy ones — `steps`, `where`), a context to read
 * state, evaluate, run nested steps, patch the UI and emit to the host.
 */

import { batch } from '@sigx/reactivity';
import { childScope, evaluate, lvalue, parseCached, ExprError } from '../expr/index.js';
import { isExprValue, isPlainObject, type ActionStep, type UIPatch, type UISpec } from '../spec/types.js';
import { sleep } from './abort.js';
import { UIActionError, type ActionTable, type HttpOptions, type UIActionContext } from './types.js';

type Container = Record<string | number, unknown>;

function str(args: Record<string, unknown>, name: string): string {
    const v = args[name];
    if (typeof v !== 'string' || !v) throw new UIActionError(`"${name}" must be a non-empty string`);
    return v;
}

function slot(ctx: UIActionContext, path: string, create = true): { container: Container; key: string | number } {
    const lv = lvalue(path, ctx.scope, ctx.env, create);
    if (!lv) throw new UIActionError(`"${path}" is not a writable path`);
    return { container: lv.container as Container, key: lv.key };
}

function arrayAt(ctx: UIActionContext, path: string): unknown[] {
    const { container, key } = slot(ctx, path);
    let arr = container[key];
    if (!Array.isArray(arr)) {
        container[key] = [];
        arr = container[key];
    }
    return arr as unknown[];
}

const stateActions: ActionTable = {
    'state.set': (args, ctx) => {
        const { container, key } = slot(ctx, str(args, 'path'));
        batch(() => {
            container[key] = args.value;
        });
    },
    'state.patch': (args, ctx) => {
        const value = args.value;
        if (!isPlainObject(value)) throw new UIActionError('"value" must be an object');
        let target: Container;
        if (typeof args.path === 'string' && args.path) {
            const { container, key } = slot(ctx, args.path);
            if (!isPlainObject(container[key])) container[key] = {};
            target = container[key] as Container;
        } else target = ctx.state;
        batch(() => {
            for (const k of Object.keys(value)) if (!k.startsWith('$') && k !== '__proto__') target[k] = value[k];
        });
    },
    'state.push': (args, ctx) => {
        const arr = arrayAt(ctx, str(args, 'path'));
        batch(() => {
            arr.push(args.value);
        });
    },
    'state.remove': (args, ctx) => {
        const arr = arrayAt(ctx, str(args, 'path'));
        batch(() => {
            if (typeof args.index === 'number') {
                if (args.index >= 0 && args.index < arr.length) arr.splice(args.index, 1);
                return;
            }
            const where = args.where;
            const source = isExprValue(where) ? where.$ : typeof where === 'string' ? where : undefined;
            if (source === undefined) throw new UIActionError('"index" or "where" is required');
            const ast = parseCached(source);
            if (ast instanceof ExprError) throw ast;
            for (let i = arr.length - 1; i >= 0; i--) {
                if (evaluate(ast, childScope(ctx.scope, { it: arr[i], index: i }), ctx.env)) arr.splice(i, 1);
            }
        });
    },
    'state.toggle': (args, ctx) => {
        const { container, key } = slot(ctx, str(args, 'path'));
        batch(() => {
            container[key] = !container[key];
        });
    }
};

function hostAllowed(url: URL, relative: boolean, http: HttpOptions | undefined): boolean {
    if (relative) return true;
    const hosts = http?.allowHosts;
    if (!hosts) return false;
    return hosts.some((h) => (h.startsWith('*.') ? url.hostname.endsWith(h.slice(1)) || url.hostname === h.slice(2) : url.hostname === h));
}

export function httpAction(http: HttpOptions | undefined): (args: Record<string, unknown>, ctx: UIActionContext) => Promise<unknown> {
    return async (args, ctx) => {
        const raw = str(args, 'url');
        const relative = !/^[a-z][a-z0-9+.-]*:/i.test(raw);
        const base = http?.baseUrl ?? (typeof location !== 'undefined' ? location.href : undefined);
        let url: URL;
        try {
            url = relative ? new URL(raw, base ?? 'http://localhost/') : new URL(raw);
        } catch {
            throw new UIActionError(`"${raw}" is not a valid URL`);
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UIActionError(`"${raw}": only http(s) URLs`);
        if (!hostAllowed(url, relative, http)) throw new UIActionError(`"${url.hostname}" is not an allowed host — add it to http.allowHosts`);
        const doFetch = http?.fetch ?? globalThis.fetch;
        if (typeof doFetch !== 'function') throw new UIActionError('fetch is not available in this runtime');
        const method = typeof args.method === 'string' ? args.method.toUpperCase() : args.body !== undefined ? 'POST' : 'GET';
        const headers: Record<string, string> = {};
        if (isPlainObject(args.headers)) for (const k of Object.keys(args.headers)) headers[k] = String(args.headers[k]);
        let body: string | undefined;
        if (args.body !== undefined && method !== 'GET') {
            body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
            if (typeof args.body !== 'string' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
        }
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(new Error('request timed out')), http?.timeoutMs ?? 30_000);
        const onAbort = () => timeout.abort(ctx.signal.reason);
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        try {
            const res = await doFetch(relative && !base ? url.pathname + url.search : url.href, { method, headers, body, signal: timeout.signal });
            const text = await res.text();
            let data: unknown = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = null;
            }
            return { ok: res.ok, status: res.status, data, text };
        } finally {
            clearTimeout(timer);
            ctx.signal.removeEventListener('abort', onAbort);
        }
    };
}

function stepsOf(args: Record<string, unknown>): ActionStep[] {
    const steps = args.steps;
    if (!Array.isArray(steps)) throw new UIActionError('"steps" must be an array');
    return steps as ActionStep[];
}

export function builtinActions(options: { readonly spec: () => UISpec; readonly http?: HttpOptions; readonly log?: (message: unknown) => void }): ActionTable {
    return {
        ...stateActions,
        'ui.patch': (args, ctx) => {
            if (!Array.isArray(args.patches)) throw new UIActionError('"patches" must be an array');
            ctx.patchUI(args.patches as UIPatch[]);
        },
        http: httpAction(options.http),
        delay: (args, ctx) => sleep(typeof args.ms === 'number' ? Math.max(0, args.ms) : 0, ctx.signal),
        emit: (args, ctx) => {
            ctx.emit(str(args, 'name'), args.payload);
        },
        call: (args, ctx) => {
            const name = str(args, 'action');
            const steps = options.spec().actions?.[name];
            if (!Array.isArray(steps)) throw new UIActionError(`no spec action named "${name}"`);
            return ctx.run(steps, childScope(ctx.scope, { $args: isPlainObject(args.args) ? args.args : {} }));
        },
        seq: (args, ctx) => ctx.run(stepsOf(args), ctx.scope),
        all: (args, ctx) => Promise.all(stepsOf(args).map((step) => ctx.run([step], childScope(ctx.scope, {})))),
        log: (args) => {
            (options.log ?? ((m: unknown) => console.log('[sigx ai-ui]', m)))(args.message);
        }
    };
}
