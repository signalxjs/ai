/**
 * @sigx/ai-ui — generative UI for SignalX.
 *
 * A JSON UI spec a model writes (and streams), the catalog that describes
 * and validates it, a safe expression language, the stream reducer, and
 * the async action runtime. Platform-neutral and `node:`-free; the renderer
 * lives on `@sigx/ai-ui/app`, the web component pack on `@sigx/ai-ui/web`.
 */

// Spec
export type { UISpec, UINode, UIFor, Value, ExprValue, ActionStep, EventBinding, RunMode, UIPatch, UIIssue, UIIssueSeverity } from './spec/types.js';
export { isExprValue } from './spec/types.js';
export type { NodeLocation } from './spec/walk.js';
export { visit, findNodeById } from './spec/walk.js';

// Expressions
export type { Expr, Template, Scope, EvalEnv, Helper, EagerHelper, LazyHelper, HelperTable, HelperContext, LValue } from './expr/index.js';
export { ExprError, parseExpr, parseTemplate, evaluate, evaluateSource, evaluateTemplate, resolveValue, lvalue, childScope, safeGet, toText, defaultHelpers, METHODS } from './expr/index.js';

// Catalog
export type { PropType, PropSchema, EventDef, ComponentDef, ActionDef, HelperDef, UICatalog, CatalogOptions, ValidateMode, ValidateOptions, DescribeOptions } from './catalog/index.js';
export { defineCatalog, baseCatalog, baseComponents, builtinActionDocs, defaultHelperDocs, validateSpec, validateSteps, uiSpecSchema, specJsonSchema, describeCatalog, COMMON_PROPS } from './catalog/index.js';

// Stream
export type { UIStreamChunk, UIDocument, UIDocumentStatus, ReduceOptions } from './stream/index.js';
export { createDocument, applyUIChunk, assembleSpec, mergeDeep, applyPatch } from './stream/index.js';

// Actions
export type { UIActionContext, ActionHandler, ActionTable, HttpOptions, ActionErrorSite, ActionRunnerOptions, RunOptions, RunResult, ActionRunner } from './actions/index.js';
export { UIActionError, createActionRunner } from './actions/index.js';

// Tool
export type { UIToolInput, UIToolResult, UIToolOptions } from './tool/index.js';
export { uiTool, uiToolJsonSchema, uiToolInputSchema } from './tool/index.js';
