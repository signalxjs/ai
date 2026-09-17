/** The expression language — parser, evaluator, helpers, value resolution. */

export type { Expr, Template, BinaryOp, LogicOp, UnaryOp } from './ast.js';
export { ExprError } from './ast.js';
export { parseExpr, parseTemplate, hasTemplate, MAX_SOURCE_LENGTH, MAX_DEPTH } from './parse.js';
export { parseCached, templateCached } from './cache.js';
export type { Scope, EvalEnv, Helper, EagerHelper, LazyHelper, HelperTable, HelperContext } from './evaluate.js';
export { evaluate, childScope, lookupVar, safeGet, toText, truthy, METHODS, NOT_FOUND } from './evaluate.js';
export { defaultHelpers, MAX_ITEMS } from './helpers.js';
export type { LValue } from './resolve.js';
export { evaluateSource, evaluateTemplate, resolveValue, lvalue, isLValueExpr } from './resolve.js';
