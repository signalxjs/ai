/**
 * @sigx/ai-agent/wire — serve a session in one place, use it from another:
 * a versioned command/event envelope, `serveSession` and `connectSession`,
 * over any transport the app chooses.
 */

export type { Cursor, WireOutputSpec, WireCommandPayload, WireCommand, WireErrorCode, WireReply, WireFrame } from './envelope.js';
export { WIRE_PROTOCOL_VERSION, isWireCommand, isWireFrame, cursorBefore } from './envelope.js';
export type { CoalesceOptions } from './coalesce.js';
export { coalesceFrames } from './coalesce.js';
export type { ServeSessionOptions, ServedSession } from './serve.js';
export { serveSession } from './serve.js';
export type { SessionTransport, ReconnectOptions, ConnectOptions, AgentSessionClient, ClientStatus } from './connect.js';
export { connectSession, RemoteCommandError } from './connect.js';
