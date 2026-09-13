/** @sigx/ai-agent/harness — the protocol kit: JSON-RPC over Web Streams, NDJSON framing, an MCP tool handler. */

export type { Framing, NdjsonOptions } from './framing.js';
export { LineTooLongError, ndjsonDecoder, ndjsonEncoder, messageDecoder, messageEncoder } from './framing.js';
export type { JsonRpcId, JsonRpcProtocolError, JsonRpcPeerOptions, RequestContext, RequestHandler, NotificationHandler, UnhandledMessage, JsonRpcPeer } from './json-rpc.js';
export { JSON_RPC, JsonRpcError, JsonRpcClosedError, JsonRpcAbortError, createJsonRpcPeer } from './json-rpc.js';
export type { McpToolHandlerOptions, McpToolHandler } from './mcp-handler.js';
export { MCP_PROTOCOL_VERSION, MCP_SUPPORTED_VERSIONS, createMcpToolHandler } from './mcp-handler.js';
export type { WebSocketLike, WebSocketStreams } from './transports.js';
export { webSocketStreams } from './transports.js';
