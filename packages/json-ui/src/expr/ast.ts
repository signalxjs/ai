/**
 * The expression AST. A deliberately small JS subset: no assignment, no
 * functions, no `new`/`this`/`typeof`, no prototype walking. Per-item logic
 * goes through lazy helpers (`where(todos, !it.done)`), never lambdas.
 */

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=';
export type LogicOp = '&&' | '||' | '??';
export type UnaryOp = '!' | '-' | '+';

export type Expr =
    | { readonly k: 'lit'; readonly v: string | number | boolean | null | undefined }
    | { readonly k: 'id'; readonly name: string }
    | { readonly k: 'member'; readonly obj: Expr; readonly prop: string }
    | { readonly k: 'index'; readonly obj: Expr; readonly index: Expr }
    /** A helper call: the callee is a bare identifier looked up in the helper table. */
    | { readonly k: 'call'; readonly name: string; readonly args: readonly Expr[] }
    /** Method sugar (`list.join(', ')`) — resolved through a fixed method → helper table, never the receiver. */
    | { readonly k: 'mcall'; readonly obj: Expr; readonly method: string; readonly args: readonly Expr[] }
    | { readonly k: 'unary'; readonly op: UnaryOp; readonly arg: Expr }
    | { readonly k: 'bin'; readonly op: BinaryOp; readonly l: Expr; readonly r: Expr }
    | { readonly k: 'logic'; readonly op: LogicOp; readonly l: Expr; readonly r: Expr }
    | { readonly k: 'cond'; readonly test: Expr; readonly yes: Expr; readonly no: Expr }
    | { readonly k: 'array'; readonly items: readonly Expr[] }
    | { readonly k: 'object'; readonly entries: ReadonlyArray<{ readonly key: string; readonly value: Expr }> };

/** A `{{…}}` template: literal text interleaved with expressions. */
export type Template = ReadonlyArray<string | Expr>;

/** A parse error, with the offset into the source it was raised at. */
export class ExprError extends Error {
    readonly pos: number;
    readonly source: string;
    constructor(message: string, source: unknown, pos: number) {
        const text = typeof source === 'string' ? source : String(source ?? '');
        super(`${message} (at ${pos} in "${text.length > 80 ? `${text.slice(0, 77)}…` : text}")`);
        this.name = 'ExprError';
        this.pos = pos;
        this.source = text;
    }
}
