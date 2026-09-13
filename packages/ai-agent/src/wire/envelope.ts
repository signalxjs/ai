/**
 * The wire envelope — versioned JSON that carries a session across any
 * transport: commands from a client, one reply per command, and event frames
 * (plus `hello` and `gap`) from the server. The library defines these
 * shapes and their semantics; the app picks the transport.
 */

import type { JsonSchema } from '@sigx/ai';
import type { AgentCapabilities, AgentEvent, Decision, PromptPart } from '../protocol/index.js';
import type { EventCursor, SessionRef } from '../session/index.js';

export const WIRE_PROTOCOL_VERSION = 1;

export type Cursor = EventCursor;

/** The structured-output request as it crosses the wire — JSON Schema only. */
export interface WireOutputSpec {
    readonly schema: JsonSchema;
    readonly name?: string;
}

export type WireCommandPayload =
    | { readonly type: 'prompt'; readonly turnId: string; readonly input: readonly PromptPart[]; readonly output?: WireOutputSpec }
    | { readonly type: 'respond'; readonly requestId: string; readonly decision: Decision }
    | { readonly type: 'cancel' }
    | { readonly type: 'configure'; readonly patch: Readonly<Record<string, string>> }
    | { readonly type: 'close' };

export type WireCommand = { readonly v: typeof WIRE_PROTOCOL_VERSION; readonly commandId: string } & WireCommandPayload;

export type WireErrorCode = 'unauthorized' | 'busy' | 'closed' | 'invalid' | 'unsupported' | 'internal';

export type WireReply =
    | { readonly v: typeof WIRE_PROTOCOL_VERSION; readonly kind: 'ack'; readonly commandId: string; readonly turnId?: string }
    | { readonly v: typeof WIRE_PROTOCOL_VERSION; readonly kind: 'error'; readonly commandId: string; readonly code: WireErrorCode; readonly message: string };

export type WireFrame =
    | {
          readonly v: typeof WIRE_PROTOCOL_VERSION;
          readonly kind: 'hello';
          readonly agentId: string;
          readonly sessionId: string;
          readonly sessionRef: SessionRef;
          readonly capabilities: AgentCapabilities;
          /** The last `(epoch, seq)` the server has emitted. */
          readonly head: Cursor;
      }
    | {
          readonly v: typeof WIRE_PROTOCOL_VERSION;
          readonly kind: 'event';
          readonly epoch: number;
          readonly seq: number;
          /** Set on a coalesced frame: it stands for `seqFrom..seq`. */
          readonly seqFrom?: number;
          readonly event: AgentEvent;
      }
    | {
          readonly v: typeof WIRE_PROTOCOL_VERSION;
          readonly kind: 'gap';
          /** The cursor the client asked for, which the server can no longer replay from. */
          readonly from: Cursor;
          /** Where the stream continues; the client resets its state to it. */
          readonly resumeAt: Cursor;
      };

const COMMANDS: ReadonlySet<string> = new Set(['prompt', 'respond', 'cancel', 'configure', 'close']);
const FRAMES: ReadonlySet<string> = new Set(['hello', 'event', 'gap']);

/** Minimal shape check — enough to route a command, never a validator. */
export function isWireCommand(value: unknown): value is WireCommand {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return v.v === WIRE_PROTOCOL_VERSION && typeof v.commandId === 'string' && typeof v.type === 'string' && COMMANDS.has(v.type);
}

export function isWireFrame(value: unknown): value is WireFrame {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return v.v === WIRE_PROTOCOL_VERSION && typeof v.kind === 'string' && FRAMES.has(v.kind);
}

/** `a` is strictly before `b`. */
export function cursorBefore(a: Cursor, b: Cursor): boolean {
    return a.epoch < b.epoch || (a.epoch === b.epoch && a.seq < b.seq);
}
