/**
 * Id namespacing for a delegate's forwarded events.
 *
 * Call ids, request ids, message and part ids are unique only WITHIN the
 * session that minted them. `agentTool` splices a delegate session's events
 * into the host's turn, so two id spaces meet: a delegate numbering its calls
 * `call_1` collides with a host doing the same, and the host transcript then
 * settles the wrong part (#125). Sequential or session-scoped ids are normal —
 * Codex item ids, ACP tool call ids, `mockModel` — so the seam, not the
 * producer, is what has to keep them apart.
 *
 * Every id a forwarded event carries is therefore rewritten with the
 * delegate's own prefix, and `ownId` maps a host-space id back when
 * `respond()` or `cancel({ agentId })` is routed into the delegate. Nesting
 * composes: a grandchild's id is prefixed once per level it travels up.
 */

import type { UnstampedEvent } from '../protocol/index.js';

/** Separator between the delegate prefix and the delegate's own id. */
const SEP = '/';

export function idPrefix(agentId: string): string {
    return `${agentId}${SEP}`;
}

/**
 * A delegate event in host space: every id prefixed, and `parentCallId` set
 * to the spawning call for what the delegate emitted at its top level.
 */
export function namespaceEvent(prefix: string, event: UnstampedEvent, callId: string): UnstampedEvent {
    const ns = (id: string) => prefix + id;
    const parentCallId = event.parentCallId === undefined ? callId : ns(event.parentCallId);
    switch (event.type) {
        case 'part-start':
            return { ...event, parentCallId, messageId: ns(event.messageId), partId: ns(event.partId) };
        case 'part-delta':
        case 'part-end':
            return { ...event, parentCallId, partId: ns(event.partId) };
        case 'tool-call':
            return { ...event, parentCallId, callId: ns(event.callId), ...(event.messageId !== undefined ? { messageId: ns(event.messageId) } : {}) };
        case 'tool-update':
            return { ...event, parentCallId, callId: ns(event.callId) };
        case 'agent-start':
            return { ...event, parentCallId, agentId: ns(event.agentId), ...(event.callId !== undefined ? { callId: ns(event.callId) } : {}) };
        case 'agent-update':
            return { ...event, parentCallId, agentId: ns(event.agentId) };
        case 'request':
            return { ...event, parentCallId, requestId: ns(event.requestId), ...(event.callId !== undefined ? { callId: ns(event.callId) } : {}) };
        case 'request-resolved':
            return { ...event, parentCallId, requestId: ns(event.requestId) };
        default:
            // `ext` and `error` carry no ids of their own.
            return { ...event, parentCallId };
    }
}

/** The delegate's own id behind a host-space one, or `undefined` when it is not this delegate's. */
export function ownId(prefix: string, id: string): string | undefined {
    return id.startsWith(prefix) ? id.slice(prefix.length) : undefined;
}
