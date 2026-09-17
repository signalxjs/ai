/**
 * The base catalog: eight components a platform pack implements, the
 * built-in actions, and the default helpers — enough for a model to build a
 * working screen, and the vocabulary every pack shares.
 */

import { defineCatalog, type ActionDef, type HelperDef, type ComponentDef } from './define-catalog.js';

export const baseComponents: Readonly<Record<string, ComponentDef>> = {
    stack: {
        description: 'A flex container. The layout primitive — lay children out in a column (default) or a row.',
        props: {
            direction: { type: 'enum', values: ['column', 'row'], description: 'Main axis. Default column.' },
            gap: { type: 'number', description: 'Space between children, in px.' },
            align: { type: 'enum', values: ['start', 'center', 'end', 'stretch'], description: 'Cross-axis alignment.' },
            justify: { type: 'enum', values: ['start', 'center', 'end', 'between', 'around'], description: 'Main-axis distribution.' },
            wrap: { type: 'boolean' },
            padding: { type: 'number', description: 'Inner padding, in px.' }
        },
        example: { type: 'stack', props: { direction: 'row', gap: 8 }, children: [] }
    },
    text: {
        description: 'A run of text. Use variant for headings and captions; text supports {{interpolation}}.',
        props: {
            text: { type: 'string', required: true, description: 'The text. May interpolate: "{{count}} items".' },
            variant: { type: 'enum', values: ['heading', 'title', 'body', 'caption', 'label'], description: 'Default body.' },
            color: { type: 'string', description: 'A CSS color.' },
            align: { type: 'enum', values: ['start', 'center', 'end'] }
        },
        events: { press: { description: 'The text was tapped/clicked.' } },
        children: 'none',
        example: { type: 'text', props: { text: 'Hello {{name}}', variant: 'heading' } }
    },
    button: {
        description: 'A button. Put what happens in on.press.',
        props: {
            label: { type: 'string', required: true },
            variant: { type: 'enum', values: ['primary', 'secondary', 'ghost', 'danger'], description: 'Default primary.' },
            disabled: { type: 'boolean' },
            size: { type: 'enum', values: ['sm', 'md', 'lg'] }
        },
        events: { press: { description: 'The button was pressed.' } },
        children: 'none',
        example: { type: 'button', props: { label: 'Add' }, on: { press: [{ do: 'state.set', path: 'count', value: { $: 'count + 1' } }] } }
    },
    input: {
        description: 'A single-line text field. Use bind to connect it to a state path; on.submit fires on Enter.',
        props: {
            placeholder: { type: 'string' },
            kind: { type: 'enum', values: ['text', 'number', 'password', 'email', 'search'], description: 'Default text.' },
            disabled: { type: 'boolean' },
            label: { type: 'string', description: 'A label rendered above the field.' }
        },
        events: {
            input: { description: 'The value changed.', payload: { value: 'string' } },
            submit: { description: 'Enter was pressed.', payload: { value: 'string' } }
        },
        children: 'none',
        bindable: true,
        example: { type: 'input', bind: 'draft', props: { placeholder: 'What needs doing?' } }
    },
    image: {
        description: 'An image.',
        props: {
            src: { type: 'string', required: true, description: 'An http(s) URL.' },
            alt: { type: 'string' },
            width: { type: 'number' },
            height: { type: 'number' },
            fit: { type: 'enum', values: ['cover', 'contain'] }
        },
        children: 'none'
    },
    list: {
        description: 'Repeats its children once per item. Set for.items to an array expression; children read the item as `item` (or for.as).',
        props: {
            gap: { type: 'number' },
            direction: { type: 'enum', values: ['column', 'row'] }
        },
        example: {
            type: 'list',
            for: { items: { $: 'todos' }, as: 'todo', key: { $: 'todo.id' } },
            children: [{ type: 'text', props: { text: '{{todo.title}}' } }]
        }
    },
    card: {
        description: 'A bordered panel with an optional title. Groups related content.',
        props: {
            title: { type: 'string' },
            padding: { type: 'number' }
        },
        example: { type: 'card', props: { title: 'Summary' }, children: [] }
    },
    divider: {
        description: 'A thin horizontal rule.',
        children: 'none'
    }
};

export const builtinActionDocs: Readonly<Record<string, ActionDef>> = {
    'state.set': { description: 'Write a value.', args: { path: { type: 'string', required: true, description: 'Dotted path: "count", "form.email", "todo.done".' }, value: { type: 'any', required: true } } },
    'state.patch': { description: 'Merge an object into the object at path (or into the root state).', args: { path: { type: 'string' }, value: { type: 'object', required: true } } },
    'state.push': { description: 'Append to the array at path (created if missing).', args: { path: { type: 'string', required: true }, value: { type: 'any', required: true } } },
    'state.remove': { description: 'Remove from the array at path: by index, or every item where the predicate (with `it`) holds.', args: { path: { type: 'string', required: true }, index: { type: 'number' }, where: { type: 'any', description: 'An expression over `it`: {"$": "it.id == todo.id"}' } } },
    'state.toggle': { description: 'Flip the boolean at path.', args: { path: { type: 'string', required: true } } },
    'ui.patch': { description: 'Change rendered nodes by id.', args: { patches: { type: 'array', required: true, description: '[{ op: "replace"|"append"|"remove"|"props", id, node?, props? }]' } } },
    http: { description: 'HTTP request. Awaited; the response is $result.', args: { url: { type: 'string', required: true }, method: { type: 'enum', values: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, body: { type: 'any', description: 'Sent as JSON.' }, headers: { type: 'object' } }, result: '{ ok, status, data (parsed JSON or null), text }' },
    delay: { description: 'Wait.', args: { ms: { type: 'number', required: true } } },
    emit: { description: 'Send an event to the host app (a chat message, navigation, …).', args: { name: { type: 'string', required: true }, payload: { type: 'any' } } },
    call: { description: 'Run a named action from the spec\'s "actions" map.', args: { action: { type: 'string', required: true }, args: { type: 'object', description: 'Available as $args inside.' } } },
    seq: { description: 'Run steps in order (a group, so one catch covers them all).', args: { steps: { type: 'array', required: true } } },
    all: { description: 'Run steps in parallel; $result is the array of results.', args: { steps: { type: 'array', required: true } } },
    log: { description: 'Console log (development aid).', args: { message: { type: 'any' } } }
};

export const defaultHelperDocs: Readonly<Record<string, HelperDef>> = {
    where: { signature: 'where(list, predicate)', description: 'Items where predicate (over `it`) holds: where(todos, !it.done). Also list.filter(pred).' },
    count: { signature: 'count(list, predicate?)', description: 'Number of items (matching predicate).' },
    map: { signature: 'map(list, expr)', description: 'expr per item: map(todos, it.title).' },
    find: { signature: 'find(list, predicate)', description: 'First matching item.' },
    any: { signature: 'any(list, predicate)', description: 'True if any item matches.' },
    all: { signature: 'all(list, predicate)', description: 'True if every item matches.' },
    sum: { signature: 'sum(list, expr?)', description: 'sum(cart, it.price * it.qty).' },
    avg: { signature: 'avg(list, expr?)', description: 'Average.' },
    min: { signature: 'min(list, expr?)', description: 'Minimum.' },
    max: { signature: 'max(list, expr?)', description: 'Maximum.' },
    sortBy: { signature: "sortBy(list, expr, 'asc'|'desc')", description: 'Sorted copy.' },
    len: { signature: 'len(value)', description: 'Length of a list or string. `list.length` works too.' },
    first: { signature: 'first(list)', description: 'First item.' },
    last: { signature: 'last(list)', description: 'Last item.' },
    at: { signature: 'at(list, i)', description: 'Item at index (negative from the end).' },
    reverse: { signature: 'reverse(list)', description: 'Reversed copy.' },
    uniq: { signature: 'uniq(list)', description: 'Distinct values.' },
    range: { signature: 'range(n) | range(from, to)', description: 'Integers.' },
    join: { signature: 'join(list, sep)', description: 'Join to a string.' },
    includes: { signature: 'includes(listOrString, x)', description: 'Membership.' },
    indexOf: { signature: 'indexOf(listOrString, x)', description: 'Position or -1.' },
    slice: { signature: 'slice(listOrString, from, to?)', description: 'A slice.' },
    keys: { signature: 'keys(object)', description: 'Own keys.' },
    values: { signature: 'values(object)', description: 'Own values.' },
    entries: { signature: 'entries(object)', description: '[{ key, value }].' },
    str: { signature: 'str(value)', description: 'To text.' },
    trim: { signature: 'trim(s)', description: 'Trim whitespace.' },
    upper: { signature: 'upper(s)', description: 'Upper case.' },
    lower: { signature: 'lower(s)', description: 'Lower case.' },
    startsWith: { signature: 'startsWith(s, prefix)', description: '' },
    endsWith: { signature: 'endsWith(s, suffix)', description: '' },
    split: { signature: 'split(s, sep)', description: '' },
    replace: { signature: 'replace(s, from, to)', description: 'Replace every occurrence.' },
    json: { signature: 'json(value)', description: 'JSON text.' },
    num: { signature: 'num(value)', description: 'To number.' },
    bool: { signature: 'bool(value)', description: 'To boolean.' },
    round: { signature: 'round(n, decimals?)', description: '' },
    floor: { signature: 'floor(n)', description: '' },
    ceil: { signature: 'ceil(n)', description: '' },
    abs: { signature: 'abs(n)', description: '' },
    clamp: { signature: 'clamp(n, lo, hi)', description: '' },
    toFixed: { signature: 'toFixed(n, decimals)', description: 'Fixed-point text.' },
    format: { signature: 'format(n, decimals?)', description: 'Locale number text: 1,234.5.' },
    coalesce: { signature: 'coalesce(a, b, …)', description: 'First non-null.' },
    uid: { signature: 'uid()', description: 'A fresh short id.' },
    now: { signature: 'now()', description: 'Epoch milliseconds.' },
    date: { signature: "date(value?, 'date'|'time'|'datetime'|'iso')", description: 'Formatted date.' }
};

/** The base catalog: 8 components, the built-in actions, the default helpers. */
export const baseCatalog = defineCatalog({
    components: baseComponents,
    actions: builtinActionDocs,
    helpers: defaultHelperDocs
});
