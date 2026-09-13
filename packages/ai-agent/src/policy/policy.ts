/**
 * The policy engine — one function every adapter calls when a harness asks.
 *
 * `resolveRequest` turns "may this run?" / "answer this" into exactly one
 * decision and exactly one `request-resolved` event: a session grant, then
 * the policy, then — when the policy says `'ask'` — a human through a
 * `request` event (interactive sessions) or an automatic deny (headless
 * ones). Timeouts and cancellation settle the same way, so a turn never
 * hangs on a question nobody will answer.
 */

import type { Decision, RequestInfo } from '../protocol/index.js';
import type { ResolvedBy, UnstampedEvent } from '../protocol/index.js';
import type { SessionGrants } from './grants.js';

/** What a policy sees: the request, plus where and how it is being asked. */
export type PolicyRequest = RequestInfo;

export interface PolicyContext {
    readonly sessionId: string;
    readonly turnId?: string;
    /** `false`: no human — `'ask'` becomes a deny. */
    readonly interactive: boolean;
    readonly grants: SessionGrants;
    /** Aborts when the turn is cancelled. */
    readonly signal: AbortSignal;
}

/**
 * `undefined` means "no opinion": inside `firstMatch` the next rule is tried;
 * as the whole policy it is the same as `'ask'`.
 */
export type PolicyResult = Decision | 'ask' | undefined;

export interface Policy {
    (request: PolicyRequest, context: PolicyContext): PolicyResult | Promise<PolicyResult>;
    /** Reported as `ruleId` on decisions that carry none of their own. */
    readonly id?: string;
}

export interface ResolveContext extends PolicyContext {
    readonly policy?: Policy;
    /** How long an interactive `request` may stay open; `undefined` waits until cancel. */
    readonly timeoutMs?: number;
    /** Reuse an id the harness already gave the request. */
    readonly requestId?: string;
    readonly now?: () => number;
    readonly newId?: () => string;
    /** Sends a `request` / `request-resolved` event into the session log. */
    readonly emit: (event: UnstampedEvent) => void;
    /** Resolves when the client calls `respond(requestId, decision)`; rejects with an `AbortError` on `signal`. */
    readonly awaitClient: (requestId: string, signal: AbortSignal) => Promise<Decision>;
}

export interface Resolved {
    readonly requestId: string;
    readonly decision: Decision;
    readonly by: ResolvedBy;
    readonly reason?: string;
    readonly ruleId?: string;
}

let requestCounter = 0;

export async function resolveRequest(request: PolicyRequest, ctx: ResolveContext): Promise<Resolved> {
    const now = ctx.now ?? Date.now;
    const requestId = ctx.requestId ?? (ctx.newId ? ctx.newId() : `req_${++requestCounter}`);
    const key = request.kind === 'permission' ? request.permissionKey : undefined;

    const settle = (decision: Decision, by: ResolvedBy, reason?: string, ruleId = decision.ruleId): Resolved => {
        if (decision.type === 'permission' && decision.outcome === 'allow' && decision.scope === 'session' && key) ctx.grants.add(key);
        ctx.emit({
            type: 'request-resolved',
            requestId,
            outcome: decision.type === 'permission' ? decision.outcome : decision.type,
            ...(decision.type === 'permission' ? { scope: decision.scope } : {}),
            ...(decision.type === 'input' ? { answers: decision.answers } : {}),
            by,
            ...(reason !== undefined ? { reason } : {}),
            ...(ruleId !== undefined ? { ruleId } : {}),
            at: now(),
            ...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {})
        });
        return { requestId, decision, by, ...(reason !== undefined ? { reason } : {}), ...(ruleId !== undefined ? { ruleId } : {}) };
    };

    // A cancelled turn answers nothing.
    if (ctx.signal.aborted) return settle({ type: 'cancel' }, 'cancel', 'cancelled');

    // 1. A session grant settles a permission before the policy runs.
    if (key && ctx.grants.has(key)) {
        return settle({ type: 'permission', outcome: 'allow', scope: 'session' }, 'policy', 'session grant', 'grant');
    }

    // 2. The policy.
    let verdict: PolicyResult = 'ask';
    if (ctx.policy) {
        verdict = await ctx.policy(request, ctx);
        if (ctx.signal.aborted) return settle({ type: 'cancel' }, 'cancel', 'cancelled');
        if (verdict !== undefined && verdict !== 'ask') {
            return settle(verdict, 'policy', undefined, verdict.ruleId ?? ctx.policy.id);
        }
    }

    // 3. `'ask'` with nobody to ask.
    if (!ctx.interactive) {
        return request.kind === 'permission'
            ? settle(
                  {
                      type: 'permission',
                      outcome: 'deny',
                      scope: 'once',
                      message: `Tool "${request.toolName ?? 'unknown'}" needs approval and this session is not interactive.`
                  },
                  'policy',
                  'non-interactive'
              )
            : settle({ type: 'cancel' }, 'policy', 'non-interactive');
    }

    // 4. Ask the client.
    ctx.emit({
        type: 'request',
        requestId,
        kind: request.kind,
        ...(request.callId !== undefined ? { callId: request.callId } : {}),
        ...(request.toolName !== undefined ? { toolName: request.toolName } : {}),
        ...(request.message !== undefined ? { message: request.message } : {}),
        ...(request.options !== undefined ? { options: request.options } : {}),
        ...(request.schema !== undefined ? { schema: request.schema } : {}),
        ...(key !== undefined ? { permissionKey: key } : {}),
        ...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {})
    });

    // One abort listener for the whole wait: it settles the race AND aborts the
    // client wait, and is removed however the race ends (a long-lived session
    // answers many requests; listeners must not pile up on its signal).
    const controller = new AbortController();
    let resolveCancelled!: (v: { kind: 'cancel' }) => void;
    const cancelled = new Promise<{ kind: 'cancel' }>((resolve) => {
        resolveCancelled = resolve;
    });
    const onAbort = () => {
        controller.abort();
        resolveCancelled({ kind: 'cancel' });
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const client = ctx.awaitClient(requestId, controller.signal).then((decision) => ({ kind: 'client' as const, decision }));
        const timeout =
            ctx.timeoutMs !== undefined
                ? new Promise<{ kind: 'timeout' }>((resolve) => {
                      timer = setTimeout(() => resolve({ kind: 'timeout' }), ctx.timeoutMs);
                  })
                : null;
        const winner = await Promise.race([client, cancelled, ...(timeout ? [timeout] : [])]).catch(() => ({ kind: 'cancel' as const }));
        controller.abort();
        if (winner.kind === 'client') return settle(winner.decision, 'client');
        if (winner.kind === 'timeout') {
            return request.kind === 'permission'
                ? settle({ type: 'permission', outcome: 'deny', scope: 'once', message: `Approval for tool "${request.toolName ?? 'unknown'}" timed out.` }, 'timeout', 'timeout')
                : settle({ type: 'cancel' }, 'timeout', 'timeout');
        }
        return settle({ type: 'cancel' }, 'cancel', 'cancelled');
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
    }
}
