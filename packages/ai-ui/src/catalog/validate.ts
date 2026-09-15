/**
 * `validateSpec` — a spec against a catalog, as issues with paths.
 *
 * Two modes. `streaming` is tolerant: only kind mismatches (a number where
 * an object belongs, `children` that is not an array) are reported, because
 * a type still typing (`"te"` for `"text"`), a missing required prop or an
 * unfinished expression are all normal mid-stream. `final` reports
 * everything. Hand-written and dependency-free, like `ChatInput` in the
 * core; `uiSpecSchema()` wraps it as a Standard Schema.
 */

import type { StandardSchemaV1 } from '@sigx/ai';
import { ExprError, isLValueExpr, METHODS, parseCached, templateCached, type Expr } from '../expr/index.js';
import { isExprValue, isPlainObject, type UIIssue, type UINode, type UISpec } from '../spec/types.js';
import { propSchema, type PropSchema, type UICatalog } from './define-catalog.js';

export type ValidateMode = 'streaming' | 'final';

export interface ValidateOptions {
    readonly mode?: ValidateMode;
}

type Path = (string | number)[];

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUN_MODES = ['drop', 'restart', 'queue', 'parallel'];
const MAX_NODES = 5000;

class Validator {
    readonly issues: UIIssue[] = [];
    private nodes = 0;
    readonly final: boolean;
    private specActions = new Set<string>();

    constructor(
        private readonly catalog: UICatalog,
        mode: ValidateMode
    ) {
        this.final = mode === 'final';
    }

    error(path: Path, message: string): void {
        this.issues.push({ path, message, severity: 'error' });
    }
    warn(path: Path, message: string): void {
        this.issues.push({ path, message, severity: 'warning' });
    }

    spec(value: unknown): void {
        if (!isPlainObject(value)) {
            this.error([], 'spec must be an object');
            return;
        }
        if (value.version !== undefined && value.version !== 1) this.error(['version'], 'must be 1');
        if (value.state !== undefined && !isPlainObject(value.state)) this.error(['state'], 'must be an object');
        if (value.computed !== undefined) {
            if (!isPlainObject(value.computed)) this.error(['computed'], 'must be an object of { "$": "expr" }');
            else
                for (const k of Object.keys(value.computed)) {
                    if (!IDENT.test(k)) this.error(['computed', k], 'must be an identifier');
                    this.exprValue(value.computed[k], ['computed', k], true);
                }
        }
        if (value.actions !== undefined) {
            if (!isPlainObject(value.actions)) this.error(['actions'], 'must be an object of step lists');
            else {
                this.specActions = new Set(Object.keys(value.actions));
                for (const k of Object.keys(value.actions)) this.steps(value.actions[k], ['actions', k]);
            }
        }
        if (value.root !== undefined) this.node(value.root, ['root']);
        else if (this.final) this.error(['root'], 'required');
        for (const k of Object.keys(value)) {
            if (!['version', 'state', 'computed', 'actions', 'root'].includes(k)) this.warn([k], 'unknown key');
        }
    }

    node(value: unknown, path: Path): void {
        if (!isPlainObject(value)) {
            this.error(path, 'node must be an object');
            return;
        }
        if (++this.nodes > MAX_NODES) {
            this.error(path, `more than ${MAX_NODES} nodes`);
            return;
        }
        const type = value.type;
        let def = undefined;
        if (type !== undefined && typeof type !== 'string') this.error([...path, 'type'], 'must be a string');
        else if (type === undefined) {
            if (this.final) this.error([...path, 'type'], 'required');
        } else {
            def = this.catalog.components[type];
            if (!def && this.final) this.error([...path, 'type'], `unknown component "${type}"`);
        }
        if (value.id !== undefined && typeof value.id !== 'string') this.error([...path, 'id'], 'must be a string');
        if (value.props !== undefined) {
            if (!isPlainObject(value.props)) this.error([...path, 'props'], 'must be an object');
            else {
                for (const name of Object.keys(value.props)) {
                    const schema = def ? propSchema(def, name) : undefined;
                    if (!schema) {
                        if (def && this.final) this.warn([...path, 'props', name], `unknown prop "${name}" on ${type as string}`);
                        continue;
                    }
                    this.prop(value.props[name], schema, [...path, 'props', name]);
                }
                if (def?.props && this.final) {
                    for (const [name, schema] of Object.entries(def.props)) {
                        if (schema.required && value.props[name] === undefined) this.error([...path, 'props', name], 'required');
                    }
                }
            }
        } else if (def?.props && this.final) {
            for (const [name, schema] of Object.entries(def.props)) {
                if (schema.required) this.error([...path, 'props', name], 'required');
            }
        }
        if (value.if !== undefined) this.exprValue(value.if, [...path, 'if'], true);
        if (value.for !== undefined) this.forClause(value.for, [...path, 'for']);
        if (value.bind !== undefined) {
            if (typeof value.bind !== 'string') this.error([...path, 'bind'], 'must be a string path');
            else if (this.final) {
                const ast = parseCached(value.bind);
                if (ast instanceof ExprError || !isLValueExpr(ast)) this.error([...path, 'bind'], 'must be a writable path like "draft" or "form.email"');
                if (def && !def.bindable) this.warn([...path, 'bind'], `${type as string} does not support bind`);
            }
        }
        if (value.on !== undefined) {
            if (!isPlainObject(value.on)) this.error([...path, 'on'], 'must be an object of event → steps');
            else
                for (const event of Object.keys(value.on)) {
                    if (def && this.final && !def.events?.[event]) this.warn([...path, 'on', event], `${type as string} has no "${event}" event`);
                    const binding = value.on[event];
                    if (isPlainObject(binding) && !Array.isArray(binding)) {
                        if (binding.mode !== undefined && !RUN_MODES.includes(binding.mode as string)) this.error([...path, 'on', event, 'mode'], `must be one of ${RUN_MODES.join(', ')}`);
                        this.steps(binding.steps, [...path, 'on', event, 'steps']);
                    } else this.steps(binding, [...path, 'on', event]);
                }
        }
        if (value.children !== undefined) {
            if (!Array.isArray(value.children)) this.error([...path, 'children'], 'must be an array of nodes');
            else {
                if (def?.children === 'none' && value.children.length && this.final) this.warn([...path, 'children'], `${type as string} takes no children`);
                value.children.forEach((child, i) => this.node(child, [...path, 'children', i]));
            }
        }
        for (const k of Object.keys(value)) {
            if (!['type', 'id', 'props', 'children', 'if', 'for', 'bind', 'on'].includes(k)) this.warn([...path, k], 'unknown key on node');
        }
    }

    forClause(value: unknown, path: Path): void {
        if (!isPlainObject(value)) {
            this.error(path, 'must be { items, as?, index?, key? }');
            return;
        }
        if (value.items === undefined) {
            if (this.final) this.error([...path, 'items'], 'required');
        } else this.exprValue(value.items, [...path, 'items'], true);
        for (const k of ['as', 'index'] as const) {
            if (value[k] !== undefined && (typeof value[k] !== 'string' || !IDENT.test(value[k] as string))) this.error([...path, k], 'must be an identifier');
        }
        if (value.key !== undefined) this.exprValue(value.key, [...path, 'key'], true);
    }

    /** A prop value: an expression is accepted for any prop; otherwise the kind must match the schema. */
    prop(value: unknown, schema: PropSchema, path: Path): void {
        if (isExprValue(value)) {
            this.expr(value.$, path);
            return;
        }
        if (typeof value === 'string' && value.includes('{{')) {
            this.template(value, path);
            return;
        }
        switch (schema.type) {
            case 'string':
                if (typeof value !== 'string') this.error(path, 'must be a string');
                break;
            case 'number':
                if (typeof value !== 'number') this.error(path, 'must be a number');
                break;
            case 'boolean':
                if (typeof value !== 'boolean') this.error(path, 'must be a boolean');
                break;
            case 'enum':
                if (typeof value !== 'string') this.error(path, 'must be a string');
                else if (this.final && schema.values && !schema.values.includes(value)) this.error(path, `must be one of ${schema.values.join(', ')}`);
                break;
            case 'object':
            case 'style':
                if (!isPlainObject(value)) this.error(path, schema.type === 'style' ? 'style must be an object, not a string' : 'must be an object');
                else if (schema.props) for (const k of Object.keys(value)) if (schema.props[k]) this.prop(value[k], schema.props[k]!, [...path, k]);
                break;
            case 'array':
                if (!Array.isArray(value)) this.error(path, 'must be an array');
                else if (schema.items) value.forEach((v, i) => this.prop(v, schema.items!, [...path, i]));
                break;
            case 'any':
                break;
        }
    }

    exprValue(value: unknown, path: Path, required: boolean): void {
        if (!isExprValue(value)) {
            if (required || value !== undefined) this.error(path, 'must be { "$": "expression" }');
            return;
        }
        this.expr(value.$, path);
    }

    expr(source: string, path: Path): void {
        if (!this.final) return;
        const ast = parseCached(source);
        if (ast instanceof ExprError) {
            this.error(path, `bad expression: ${ast.message}`);
            return;
        }
        this.checkNames(ast, path);
    }

    template(source: string, path: Path): void {
        if (!this.final) return;
        const tpl = templateCached(source);
        if (tpl instanceof ExprError) {
            this.error(path, `bad expression: ${tpl.message}`);
            return;
        }
        for (const part of tpl) if (typeof part !== 'string') this.checkNames(part, path);
    }

    /** Helper and method names must exist — the one static check the language allows. */
    private checkNames(expr: Expr, path: Path): void {
        const visit = (e: Expr): void => {
            switch (e.k) {
                case 'call':
                    if (!this.catalog.helpers[e.name]) this.error(path, `unknown helper "${e.name}"`);
                    e.args.forEach(visit);
                    break;
                case 'mcall':
                    if (!METHODS[e.method]) this.error(path, `unknown method ".${e.method}()" — use a helper`);
                    visit(e.obj);
                    e.args.forEach(visit);
                    break;
                case 'member':
                    visit(e.obj);
                    break;
                case 'index':
                    visit(e.obj);
                    visit(e.index);
                    break;
                case 'unary':
                    visit(e.arg);
                    break;
                case 'bin':
                case 'logic':
                    visit(e.l);
                    visit(e.r);
                    break;
                case 'cond':
                    visit(e.test);
                    visit(e.yes);
                    visit(e.no);
                    break;
                case 'array':
                    e.items.forEach(visit);
                    break;
                case 'object':
                    e.entries.forEach((en) => visit(en.value));
                    break;
                default:
                    break;
            }
        };
        visit(expr);
    }

    steps(value: unknown, path: Path): void {
        if (!Array.isArray(value)) {
            this.error(path, 'must be an array of steps');
            return;
        }
        value.forEach((step, i) => this.step(step, [...path, i]));
        if (this.final) this.negatedPairs(value, path);
    }

    /**
     * Two adjacent steps guarded by `X` and `!X` look like if/else but are
     * not: the second `if` is evaluated after the first step ran, so when the
     * first step changes what `X` reads, both run. The fix is `else`.
     */
    private negatedPairs(steps: unknown[], path: Path): void {
        const source = (s: unknown): string | undefined => (isPlainObject(s) && isExprValue(s.if) ? s.if.$.replace(/\s+/g, '') : undefined);
        const negated = (a: string, b: string): boolean => b === `!(${a})` || b === `!${a}` || a === `!(${b})` || a === `!${b}`;
        for (let i = 1; i < steps.length; i++) {
            const a = source(steps[i - 1]);
            const b = source(steps[i]);
            if (a && b && negated(a, b)) {
                this.warn([...path, i, 'if'], 'negates the previous step\'s "if", but is evaluated AFTER that step ran — if that step changes what the condition reads, both run. Put these steps in the previous step\'s "else" instead.');
            }
        }
    }

    step(value: unknown, path: Path): void {
        if (!isPlainObject(value)) {
            this.error(path, 'step must be an object');
            return;
        }
        const name = value.do;
        if (typeof name !== 'string') {
            if (name !== undefined || this.final) this.error([...path, 'do'], 'must be an action name');
        } else if (this.final && !this.catalog.actions[name]) this.error([...path, 'do'], `unknown action "${name}"`);
        if (value.if !== undefined) this.exprValue(value.if, [...path, 'if'], true);
        if (value.else !== undefined) {
            if (value.if === undefined) this.warn([...path, 'else'], 'has no "if" to be the else of');
            this.steps(value.else, [...path, 'else']);
        }
        if (value.as !== undefined && (typeof value.as !== 'string' || !IDENT.test(value.as))) this.error([...path, 'as'], 'must be an identifier');
        if (value.catch !== undefined) this.steps(value.catch, [...path, 'catch']);
        if (name === 'call' && this.final) {
            if (typeof value.action !== 'string') this.error([...path, 'action'], 'required');
            else if (!this.specActions.has(value.action)) this.error([...path, 'action'], `no spec action named "${value.action}"`);
        }
        if ((name === 'seq' || name === 'all') && value.steps !== undefined) this.steps(value.steps, [...path, 'steps']);
        if (name === 'ui.patch' && value.patches !== undefined && !Array.isArray(value.patches)) this.error([...path, 'patches'], 'must be an array');
        // Argument values may carry expressions anywhere; check the ones we can see.
        for (const k of Object.keys(value)) {
            if (['do', 'if', 'else', 'as', 'catch', 'steps'].includes(k)) continue;
            this.argValue(value[k], [...path, k]);
        }
    }

    private argValue(value: unknown, path: Path, depth = 0): void {
        if (depth > 16) return;
        if (isExprValue(value)) this.expr(value.$, path);
        else if (typeof value === 'string' && value.includes('{{')) this.template(value, path);
        else if (Array.isArray(value)) value.forEach((v, i) => this.argValue(v, [...path, i], depth + 1));
        else if (isPlainObject(value)) for (const k of Object.keys(value)) this.argValue(value[k], [...path, k], depth + 1);
    }
}

export function validateSpec(spec: unknown, catalog: UICatalog, options: ValidateOptions = {}): UIIssue[] {
    const v = new Validator(catalog, options.mode ?? 'final');
    v.spec(spec);
    return v.issues;
}

/** Steps on their own (a host wanting to check an action list). */
export function validateSteps(steps: unknown, catalog: UICatalog): UIIssue[] {
    const v = new Validator(catalog, 'final');
    v.steps(steps, []);
    return v.issues;
}

/**
 * The spec as a Standard Schema (final mode; warnings are not failures), so
 * `defineTool({ input })` and `generateObject({ schema })` take it directly.
 */
export function uiSpecSchema(catalog: UICatalog): StandardSchemaV1<UISpec, UISpec> {
    return {
        '~standard': {
            version: 1,
            vendor: 'sigx-ai-ui',
            validate(value: unknown) {
                const issues = validateSpec(value, catalog, { mode: 'final' }).filter((i) => i.severity === 'error');
                if (issues.length) return { issues: issues.map((i) => ({ message: i.message, path: [...i.path] })) };
                return { value: value as UISpec };
            }
        }
    };
}

/** Narrow a validated value. */
export function isUINode(value: unknown): value is UINode {
    return isPlainObject(value) && typeof value.type === 'string';
}
