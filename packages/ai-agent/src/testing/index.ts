/** @sigx/ai-agent/testing — a scripted agent and the conformance suite every adapter runs. */

export type { MockToolStep, MockAgentStep, MockStep, MockRespondContext, MockAgentOptions, MockAgent } from './mock-agent.js';
export { mockAgent, MOCK_CAPABILITIES } from './mock-agent.js';
export type { ConformanceScenario, ConformanceCase, ConformanceOptions } from './conformance.js';
export { agentConformance, CONFORMANCE_SCENARIOS, CONFORMANCE_TOOLS } from './conformance.js';
export type { EventInvariantOptions } from './invariants.js';
export { checkEventInvariants, checkReplayEquality, checkResultMatchesTurnEnd } from './invariants.js';
export { ConformanceError } from './assert.js';
export type { AgentFixture, FixtureSession, FixtureSessionOptions, FixtureCommand, FixtureEntry, RecordAgentOptions, RecordingAgent, ReplayAgentOptions } from './record.js';
export { recordAgent, replayAgent, serializeFixture, ReplayMismatchError, FIXTURE_VERSION } from './record.js';
