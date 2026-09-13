/** The two errors the contract names: a harness failure with a code, and a prompt on a busy session. */

export type AgentErrorCode = 'auth_required' | 'rate_limited' | 'context_exceeded' | 'process_exited' | 'provider_error' | 'protocol_error';

/** A harness or protocol failure — the same shape as the `error` event, thrown. */
export class AgentError extends Error {
    override readonly name = 'AgentError';
    constructor(
        readonly code: AgentErrorCode,
        message: string,
        readonly recoverable = false,
        options?: { cause?: unknown; data?: unknown }
    ) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.data = options?.data;
    }
    /** Vendor detail (e.g. the auth methods an agent accepts) — plain JSON. */
    readonly data: unknown;
}

/** `prompt()` while a turn runs on a session without the `steer` capability. */
export class SessionBusyError extends Error {
    override readonly name = 'SessionBusyError';
    constructor(
        readonly sessionId: string,
        readonly turnId: string
    ) {
        super(`[sigx ai-agent] session "${sessionId}" is busy: turn "${turnId}" is still running (the agent does not support steering)`);
    }
}
