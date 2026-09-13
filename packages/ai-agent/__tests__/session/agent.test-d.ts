import { describe, it, expectTypeOf } from 'vitest';
import type { SessionOptions, EventContext, AgentEvent } from '@sigx/ai-agent';

// `raw` was a declared-but-never-produced option: no agent attached native
// payloads, and one that did would break the JSON round-trip invariant. These
// assertions keep it from creeping back without a producer.
describe('SessionOptions / EventContext', () => {
    it('carry no raw option', () => {
        expectTypeOf<SessionOptions>().not.toHaveProperty('raw');
        expectTypeOf<EventContext>().not.toHaveProperty('raw');
        expectTypeOf<AgentEvent>().not.toHaveProperty('raw');
    });
});
