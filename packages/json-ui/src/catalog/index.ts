/** The catalog — the model-facing contract: components, actions, helpers; validation, JSON Schema and prompt text derived from it. */

export type { PropType, PropSchema, EventDef, ComponentDef, ActionDef, HelperDef, UICatalog, CatalogOptions } from './define-catalog.js';
export { defineCatalog, propSchema, COMMON_PROPS } from './define-catalog.js';
export { baseCatalog, baseComponents, builtinActionDocs, defaultHelperDocs } from './base.js';
export type { ValidateMode, ValidateOptions } from './validate.js';
export { validateSpec, validateSteps, uiSpecSchema, isUINode } from './validate.js';
export { specJsonSchema } from './json-schema.js';
export type { DescribeOptions } from './prompt.js';
export { describeCatalog } from './prompt.js';
