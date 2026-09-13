/**
 * The invariants every adapter must hold — checked over a session's events
 * after each conformance scenario.
 */

import type { AgentEvent } from '../protocol/index.js';
import type { TurnResult } from '../session/index.js';
import { createTranscript, type AgentReducer } from '../state/index.js';
import { jsonEqual } from '../utils/json.js';
import { assert, assertEqual, fail } from './assert.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'denied']);
const AGENT_TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Gapless `seq` per epoch, one start/end per turn, terminal tools and agents, one resolution per request, JSON-safe, nesting refers back. */
export function checkEventInvariants(events: readonly AgentEvent[]): void {
    assert(events.length > 0, 'no events were observed');
    const sessionId = events[0]!.sessionId;
    let epoch = events[0]!.epoch;
    // Gapless from the first event the observer saw: a session may have emitted
    // events (a config announcement) before the client subscribed.
    let seq = events[0]!.seq - 1;
    const turnStarts = new Map<string, number>();
    const turnEnds = new Map<string, number>();
    const calls = new Map<string, string>();
    const agents = new Map<string, string>();
    const requests = new Map<string, number>();
    const resolved = new Map<string, number>();

    for (const e of events) {
        assert(e.sessionId === sessionId, `event ${e.seq} belongs to another session ("${e.sessionId}", expected "${sessionId}")`);
        if (e.epoch !== epoch) {
            assert(e.epoch > epoch, `epoch went backwards: ${epoch} → ${e.epoch} at seq ${e.seq}`);
            epoch = e.epoch;
            // Same rule as the first epoch: the observer may have missed this
            // epoch's early events too, so baseline from the first one it saw.
            seq = e.seq - 1;
        }
        assert(e.seq === seq + 1, `seq gap in epoch ${epoch}: expected ${seq + 1}, got ${e.seq} (${e.type})`);
        seq = e.seq;
        const copy = JSON.parse(JSON.stringify(e)) as unknown;
        assert(jsonEqual(copy, e), `event ${e.epoch}:${e.seq} (${e.type}) does not survive JSON`);
        if (e.parentCallId !== undefined) assert(calls.has(e.parentCallId), `event ${e.seq} (${e.type}) refers to parentCallId "${e.parentCallId}" before its tool-call`);
        switch (e.type) {
            case 'turn-start':
                assert(e.turnId !== undefined, `turn-start at seq ${e.seq} has no turnId`);
                turnStarts.set(e.turnId, (turnStarts.get(e.turnId) ?? 0) + 1);
                break;
            case 'turn-end':
                assert(e.turnId !== undefined, `turn-end at seq ${e.seq} has no turnId`);
                turnEnds.set(e.turnId, (turnEnds.get(e.turnId) ?? 0) + 1);
                break;
            case 'tool-call':
                calls.set(e.callId, 'pending');
                break;
            case 'tool-update':
                assert(calls.has(e.callId), `tool-update for unknown callId "${e.callId}" at seq ${e.seq}`);
                calls.set(e.callId, e.status);
                break;
            case 'agent-start':
                assert(!agents.has(e.agentId), `agent "${e.agentId}" started twice (seq ${e.seq})`);
                if (e.callId !== undefined) assert(calls.has(e.callId), `agent "${e.agentId}" at seq ${e.seq} is bound to callId "${e.callId}" before its tool-call`);
                agents.set(e.agentId, 'running');
                break;
            case 'agent-update':
                assert(agents.has(e.agentId), `agent-update for unknown agentId "${e.agentId}" at seq ${e.seq}`);
                agents.set(e.agentId, e.status);
                break;
            case 'request':
                requests.set(e.requestId, (requests.get(e.requestId) ?? 0) + 1);
                break;
            case 'request-resolved':
                resolved.set(e.requestId, (resolved.get(e.requestId) ?? 0) + 1);
                break;
        }
    }
    for (const [turnId, n] of turnStarts) {
        assert(n === 1, `turn "${turnId}" has ${n} turn-start events`);
        assert(turnEnds.get(turnId) === 1, `turn "${turnId}" has ${turnEnds.get(turnId) ?? 0} turn-end events`);
    }
    for (const [turnId] of turnEnds) assert(turnStarts.has(turnId), `turn "${turnId}" ended without starting`);
    for (const [callId, status] of calls) assert(TERMINAL.has(status), `tool call "${callId}" never reached a terminal status (last: ${status})`);
    for (const [agentId, status] of agents) assert(AGENT_TERMINAL.has(status), `agent "${agentId}" never reached a terminal status (last: ${status})`);
    for (const [id, n] of requests) {
        assert(n === 1, `request "${id}" was emitted ${n} times`);
        assert(resolved.get(id) === 1, `request "${id}" has ${resolved.get(id) ?? 0} resolutions`);
    }
    for (const [id, n] of resolved) assert(n === 1, `request "${id}" was resolved ${n} times`);
}

/** `turn.result` must equal the turn's `turn-end` event. */
export function checkResultMatchesTurnEnd(events: readonly AgentEvent[], result: TurnResult): void {
    const end = events.find((e) => e.type === 'turn-end' && e.turnId === result.turnId);
    assert(end && end.type === 'turn-end', `no turn-end for turn "${result.turnId}"`);
    const { type: _t, sessionId: _s, epoch: _e, seq: _q, turnId: _i, parentCallId: _p, ...payload } = end;
    const { turnId: _tid, ...res } = result;
    assertEqual(res, payload, `turn.result differs from the turn-end event of "${result.turnId}"`);
}

/** Reducing from a snapshot at every `k` must equal the full reduction. */
export function checkReplayEquality(events: readonly AgentEvent[], reducer: AgentReducer): void {
    const sessionId = events[0]?.sessionId ?? 'unknown';
    const full = createTranscript(sessionId);
    for (const e of events) reducer(full, e);
    let snapshot = createTranscript(sessionId);
    for (let k = 0; k < events.length; k++) {
        const fromHere = structuredClone(snapshot);
        for (let i = k; i < events.length; i++) reducer(fromHere, events[i]!);
        if (!jsonEqual(fromHere, full)) fail(`replay from seq ${events[k]!.epoch}:${events[k]!.seq} differs from the full reduction`);
        reducer(snapshot, events[k]!);
    }
}
