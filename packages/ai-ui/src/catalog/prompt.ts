/**
 * `describeCatalog` — the system-prompt section that teaches a model the
 * spec: the components (props, events, children), the actions, the helpers,
 * and the rules of the expression language. Generated from the catalog so
 * a host that adds a component or an action never has to write prose.
 */

import type { PropSchema, UICatalog } from './define-catalog.js';

function propLine(name: string, schema: PropSchema): string {
    let kind: string = schema.type;
    if (schema.type === 'enum' && schema.values) kind = schema.values.join('|');
    if (schema.type === 'style') kind = 'object';
    if (schema.type === 'array' && schema.items) kind = `${schema.items.type}[]`;
    const parts = [`${name}: ${kind}`];
    if (schema.required) parts.push('(required)');
    if (schema.description) parts.push(`— ${schema.description}`);
    return parts.join(' ');
}

export interface DescribeOptions {
    /** Include the built-in expression cheat sheet and the rules. @default true */
    readonly rules?: boolean;
    /** Include the helper list. @default true */
    readonly helpers?: boolean;
}

export function describeCatalog(catalog: UICatalog, options: DescribeOptions = {}): string {
    const out: string[] = [];
    out.push('## UI spec');
    out.push('');
    out.push('A UI is one JSON object: { "version": 1, "state": {…}, "computed": {…}, "actions": {…}, "root": <node> }.');
    out.push('A node is { "type", "id"?, "props"?, "if"?, "for"?, "bind"?, "on"?, "children"? } — write keys in that order, "type" first and "children" last.');
    out.push('');
    out.push('### Components');
    for (const [name, def] of Object.entries(catalog.components)) {
        out.push(`- **${name}** — ${def.description}`);
        const props = def.props ? Object.entries(def.props) : [];
        if (props.length) out.push(`  props: ${props.map(([n, s]) => propLine(n, s)).join('; ')}`);
        const events = def.events ? Object.entries(def.events) : [];
        if (events.length) {
            out.push(
                `  events: ${events
                    .map(([n, e]) => {
                        const payload = e.payload ? ` ($event.${Object.keys(e.payload).join(', $event.')})` : '';
                        return `${n}${payload}${e.description ? ` — ${e.description}` : ''}`;
                    })
                    .join('; ')}`
            );
        }
        const notes: string[] = [];
        if (def.children === 'none') notes.push('no children');
        if (def.bindable) notes.push('supports "bind"');
        if (notes.length) out.push(`  ${notes.join('; ')}`);
        if (def.example) out.push(`  e.g. ${JSON.stringify(def.example)}`);
    }
    out.push('  Every component also takes "style" (an OBJECT of camelCase CSS properties — never a string) and "class".');
    out.push('');
    out.push('### Actions');
    out.push('An event handler is a list of steps, run in order and awaited: "on": { "press": [ { "do": "<action>", …args } ] }.');
    out.push('A step may carry "if" ({"$": …}, skip when false), "else" (steps to run instead when "if" is false), "as" (bind the result to a name for later steps; it is also $result) and "catch" (steps to run if it fails; $error is set).');
    out.push('Steps run in order and each "if" is evaluated right before its step, so it sees what earlier steps wrote. For either/or logic use one step with "if" and "else" — never two steps guarded by X and !X (if the first step changes X, both run).');
    for (const [name, def] of Object.entries(catalog.actions)) {
        const args = def.args ? Object.entries(def.args).map(([n, s]) => propLine(n, s)).join('; ') : '';
        out.push(`- **${name}** — ${def.description}${args ? ` Args: ${args}.` : ''}${def.result ? ` Result: ${def.result}` : ''}`);
    }
    if (options.rules !== false) {
        out.push('');
        out.push('### Expressions');
        out.push('- A dynamic value is { "$": "<expr>" } anywhere a value goes; inside a string, interpolate with {{expr}}: "{{count}} items".');
        out.push('- Expressions are a JS subset: literals, state names (`count`, `todos`), member/index access (`user.name`, `todos[0]`), arithmetic, comparisons, `&&`, `||`, `??`, `?:`, array and object literals, and helper calls.');
        out.push('- No functions or lambdas. For per-item logic use `it` inside a helper: where(todos, !it.done), sum(cart, it.price * it.qty), count(todos, it.done).');
        out.push('- Scope: state keys, "computed" names, loop variables from "for", $event (the event payload), $result / $error / $args inside actions, $pending (true while this node\'s action runs).');
        out.push('- "for": { "items": {"$": "todos"}, "as": "todo", "key": {"$": "todo.id"} } repeats the node\'s children once per item; write to the item with paths like "todo.done".');
        out.push('- "bind": "draft" on an input keeps state.draft and the field in sync. "if": {"$": "…"} renders the node only when truthy.');
        out.push('- Declare every state key you read in "state" with an initial value. Use "computed" for derived values. Keep ids on nodes you may patch later.');
    }
    if (options.helpers !== false) {
        out.push('');
        out.push('### Helpers');
        out.push(
            Object.values(catalog.helpers)
                .map((h) => (h.description ? `${h.signature} — ${h.description}` : h.signature))
                .join('\n')
        );
    }
    return out.join('\n');
}
