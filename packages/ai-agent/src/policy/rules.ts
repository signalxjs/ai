/** Built-in policies — small, named, composable through `firstMatch`. */

import type { Decision } from '../protocol/index.js';
import type { Policy, PolicyRequest, PolicyResult } from './policy.js';

/** Give a policy an `id` so decisions it makes carry it as `ruleId`. */
export function rule(id: string, policy: (request: PolicyRequest, context: Parameters<Policy>[1]) => PolicyResult | Promise<PolicyResult>): Policy {
    return Object.assign(policy, { id });
}

const allow = (scope: 'once' | 'session' = 'once'): Decision => ({ type: 'permission', outcome: 'allow', scope });
const deny = (message: string): Decision => ({ type: 'permission', outcome: 'deny', scope: 'once', message });

/** Every permission is granted; input requests still go to the client. */
export const allowAll: Policy = rule('allowAll', (request) => (request.kind === 'permission' ? allow() : undefined));

/** Every permission is refused with a message the model can act on. */
export const denyAll: Policy = rule('denyAll', (request) =>
    request.kind === 'permission' ? deny(`Tool "${request.toolName ?? 'unknown'}" is not allowed by policy.`) : { type: 'cancel' }
);

/** Allows tools whose annotations say `readOnly`; no opinion on the rest. */
export const allowReadOnly: Policy = rule('allowReadOnly', (request) =>
    request.kind === 'permission' && request.annotations?.readOnly === true ? allow() : undefined
);

/** Allows the named tools; no opinion on the rest. */
export function allowTools(names: readonly string[]): Policy {
    const set = new Set(names);
    return rule('allowTools', (request) => (request.kind === 'permission' && request.toolName !== undefined && set.has(request.toolName) ? allow() : undefined));
}

/** Denies the named tools; no opinion on the rest. */
export function denyTools(names: readonly string[]): Policy {
    const set = new Set(names);
    return rule('denyTools', (request) =>
        request.kind === 'permission' && request.toolName !== undefined && set.has(request.toolName) ? deny(`Tool "${request.toolName}" is not allowed by policy.`) : undefined
    );
}

/**
 * The first rule with an opinion decides; `ruleId` is that rule's `id` (or
 * `rule<index>`). No opinion anywhere → `'ask'`.
 */
export function firstMatch(...rules: readonly Policy[]): Policy {
    return rule('firstMatch', async (request, context) => {
        for (let i = 0; i < rules.length; i++) {
            const r = rules[i]!;
            const verdict = await r(request, context);
            if (verdict === undefined) continue;
            if (verdict === 'ask') return 'ask';
            return verdict.ruleId !== undefined ? verdict : { ...verdict, ruleId: r.id ?? `rule${i}` };
        }
        return 'ask';
    });
}
