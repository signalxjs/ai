/**
 * Requests and decisions — the shapes a harness uses to ask, and a policy or
 * a human uses to answer. Domain-neutral: a permission is "may this tool run",
 * an input request is "answer these questions"; what the tool does is the
 * harness's business, described through `ToolAnnotations` and `category`.
 */

import type { JsonSchema } from '@sigx/ai';

export type RequestKind = 'permission' | 'input';

/**
 * Hints about a tool's effects, aligned with MCP tool annotations. Honest by
 * construction: an adapter sets only what it knows. (The same shape lands on
 * `defineTool` in `@sigx/ai`; it is repeated here so this package's contract
 * stands on its own.)
 */
export interface ToolAnnotations {
    readonly readOnly?: boolean;
    readonly destructive?: boolean;
    readonly idempotent?: boolean;
    readonly openWorld?: boolean;
}

/** A choice offered by a request — a permission option or an input answer. */
export interface RequestOption {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}

export type Decision =
    | {
          readonly type: 'permission';
          readonly outcome: 'allow' | 'deny';
          /** `session`: remembered for the session under the request's `permissionKey`. */
          readonly scope: 'once' | 'session';
          /** Shown to the model on deny — why, and what to do instead. */
          readonly message?: string;
          readonly ruleId?: string;
      }
    | { readonly type: 'input'; readonly answers: unknown; readonly ruleId?: string }
    | { readonly type: 'cancel'; readonly ruleId?: string };

/** One value of a `config` option. */
export interface ConfigValue {
    readonly id: string;
    readonly label?: string;
    readonly description?: string;
}

/** A harness setting a client may change through `configure()` — a mode, the model, the effort. */
export interface ConfigOption {
    readonly id: string;
    readonly label: string;
    readonly values: readonly ConfigValue[];
    readonly current: string;
}

/** What a request wants answered, in the shape both `request` events and policies see. */
export interface RequestInfo {
    readonly kind: RequestKind;
    readonly callId?: string;
    readonly toolName?: string;
    readonly input?: unknown;
    readonly annotations?: ToolAnnotations;
    /** A domain category (`./coding` defines `read | edit | execute | …`); `undefined` for non-coding tools. */
    readonly category?: string;
    /** Where the tool lives: a client `defineTool`, the harness's own tool set, or an MCP server. */
    readonly source: 'client' | 'native' | 'mcp';
    /** Human-readable summary of what is being asked. */
    readonly message?: string;
    readonly options?: readonly RequestOption[];
    /** For `input`: the shape of `answers`. */
    readonly schema?: JsonSchema;
    /** Stable key for session-scoped grants (adapter-defined, e.g. `Bash:git status`). */
    readonly permissionKey?: string;
}
