/**
 * @sigx/ai-agent/coding — the coding vocabulary on top of the domain-neutral
 * core: categories, typed `coding.*` extension events and their reducer
 * plugin, `CodingSessionOptions`, and path-aware policies.
 */

export type { CodingCategory } from './categories.js';
export { CODING_CATEGORIES, isCodingCategory, categoryOf } from './categories.js';
export type { CodingDiff, CodingTerminal, CodingTerminalExit, CodingPlanEntry, CodingPlan, CodingFilesChanged, CodingEventMap, CodingEventName, CodingEvent } from './extensions.js';
export { CODING_NS, codingEvent, isCodingEvent } from './extensions.js';
export type { CodingDiffRecord, CodingTerminalState, CodingState, CodingExtensionOptions } from './reducer.js';
export { codingExtension, codingState, codingStateOf } from './reducer.js';
export type { CodingSessionOptions } from './options.js';
export type { NormalizedPath } from './paths.js';
export { isWindowsPath, normalizePath, resolveFrom, isWithin } from './paths.js';
export type { DenyOutsideOptions } from './policy.js';
export { allowCategories, denyOutside, pathsOf } from './policy.js';
