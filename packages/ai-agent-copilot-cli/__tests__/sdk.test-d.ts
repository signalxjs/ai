/**
 * The slice of the SDK the adapter uses (`CopilotClientLike`,
 * `CopilotSessionLike`) against the real classes of `@github/copilot-sdk`:
 * plain assignments prove the SDK's client and session satisfy what
 * `copilotCli({ client })` accepts, so the fake in tests and the real thing
 * are interchangeable, and a breaking SDK release fails here rather than
 * at runtime.
 */
import type { CopilotClient, CopilotSession, PermissionHandler, SessionConfig, Tool } from '@github/copilot-sdk';
import type { CopilotClientLike, CopilotSessionLike, ReasoningEffort, UserInputHandler } from '../src/options';
import type { createPermissionHandler, createUserInputHandler } from '../src/permissions';
import type { toCopilotTools } from '../src/tools';

declare const from: <T>() => T;

// The real client and session satisfy the seam.
const _client: CopilotClientLike = from<CopilotClient>();
const _session: CopilotSessionLike = from<CopilotSession>();

// What the session hands the SDK is what the SDK takes.
const _permission: NonNullable<SessionConfig['onPermissionRequest']> = from<ReturnType<typeof createPermissionHandler>>();
const _input: NonNullable<SessionConfig['onUserInputRequest']> = from<ReturnType<typeof createUserInputHandler>>();
const _tools: NonNullable<SessionConfig['tools']> = from<ReturnType<typeof toCopilotTools>>();
const _tool: Tool = from<ReturnType<typeof toCopilotTools>[number]>();
const _handler: PermissionHandler = from<ReturnType<typeof createPermissionHandler>>();
const _userInput: UserInputHandler = from<NonNullable<SessionConfig['onUserInputRequest']>>();
const _effort: ReasoningEffort = from<'max'>();

void [_client, _session, _permission, _input, _tools, _tool, _handler, _userInput, _effort];
