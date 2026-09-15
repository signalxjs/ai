# @sigx/ai-ui

Generative UI for [SignalX](https://sigx.dev/) — a JSON UI spec a model
writes (and streams), the catalog that tells it what it may build and lets
you validate what it built, a safe expression language, reactive state,
pluggable async actions, and a renderer on `@sigx/runtime-core` that works
wherever sigx renders. **Proof of concept** — the shape is settling.

Three entries:

| Entry | What |
|---|---|
| `@sigx/ai-ui` | the spec, expressions, catalog + validation, the stream reducer, the action runtime, `uiTool()` |
| `@sigx/ai-ui/app` | `UIView` and `createUIRuntime` — the renderer, on `@sigx/runtime-core` (never the `sigx` umbrella) |
| `@sigx/ai-ui/web` | `webRegistry()` — the base catalog as HTML elements, plus `webStyles` |

## The whole thing in one chat turn

```ts
// server — the model gets a tool whose description IS the catalog
import { uiTool } from '@sigx/ai-ui';
yield* chatStream({ model, tools: [uiTool()], messages });
```

```tsx
// client — a render_ui tool part becomes a live UI while its arguments stream
import { UIView } from '@sigx/ai-ui/app';
import { webRegistry } from '@sigx/ai-ui/web';

if (part.type === 'tool' && part.name === 'render_ui')
    return <UIView spec={part.input?.spec} done={part.state !== 'streaming'} registry={webRegistry()} onEmit={(name, payload) => …} />;
```

The core's reducer re-parses `tool-input` deltas into `part.input` on every
token; `UIView` merges each new object into its own reactive document in
place, so nodes that already rendered keep their identity and the interface
grows as the model writes it. `done` flips when the call settles, which is
when the spec is validated against the catalog.

## The spec

```json
{ "version": 1,
  "state": { "draft": "", "todos": [] },
  "computed": { "remaining": { "$": "count(todos, !it.done)" } },
  "actions": { "add": [
      { "do": "state.push", "path": "todos", "value": { "$": "{ id: uid(), title: draft, done: false }" } },
      { "do": "state.set", "path": "draft", "value": "" } ] },
  "root": { "type": "stack", "props": { "gap": 8 }, "children": [
      { "type": "text", "props": { "text": "{{remaining}} left", "variant": "heading" } },
      { "type": "input", "bind": "draft", "props": { "placeholder": "Todo" }, "on": { "submit": [ { "do": "call", "action": "add" } ] } },
      { "type": "button", "props": { "label": "Add", "disabled": { "$": "draft == ''" } }, "on": { "press": [ { "do": "call", "action": "add" } ] } },
      { "type": "list", "for": { "items": { "$": "todos" }, "as": "todo", "key": { "$": "todo.id" } },
        "children": [ { "type": "text", "props": { "text": "{{todo.title}}" }, "on": { "press": [ { "do": "state.toggle", "path": "todo.done" } ] } } ] },
      { "type": "text", "if": { "$": "todos.length == 0" }, "props": { "text": "Nothing yet" } } ] } }
```

A **node** is `{ type, id?, props?, if?, for?, bind?, on?, children? }` —
in that order, so a streaming node names its component before its subtree
arrives. `id` is an addressing handle for patches, never the reconciliation
key (that is the node's identity, which survives streaming). `for` repeats
the node's `children` once per item, with the item and index in scope.
`bind` is a writable path (`draft`, `form.email`, `todo.done`) kept in sync
with a bindable component. `on` maps an event to a list of steps.

**Values** are JSON, or `{ "$": "expr" }`, or a string with `{{expr}}`
interpolation. `style` is always an object (the Lynx rule, adopted
everywhere).

**State** lives in the runtime, not the spec: `spec.state` seeds it key by
key, once, so a `state` block that streams in late never clobbers what the
user already typed.

### Expressions

A JS subset with its own parser — no `eval`, no functions. Literals, state
names, member and index access (tolerant: a missing key is `undefined`),
arithmetic, comparisons, `&& || ??`, `?:`, array and object literals, and
helper calls. Per-item logic uses lazy helpers with `it` and `index` bound:
`where(todos, !it.done)`, `sum(cart, it.price * it.qty)`,
`sortBy(items, it.name, 'desc')`. Method sugar maps onto the same table
(`todos.filter(it.done).length`, `name.toUpperCase()`).

Scope, in order: loop variables and action variables (`$event`, `$result`,
`$error`, `$args`, `as` bindings, `$pending`), `computed` names, then
state. Own properties only; `__proto__`, `constructor` and `$`-prefixed
keys of data objects are unreachable.

### Actions

Steps run in order, each awaited: `{ "do", "if"?, "else"?, "as"?, "catch"?, …args }`.
Consecutive steps that carry `if` form one decision, like a switch: all
their conditions are judged against the state as it was before the first
of them ran, so `if: overwrite` / `if: !overwrite` on adjacent steps are
two cases, never both. A step without `if` ends the group and sees the
writes. Step values are always resolved live. `else` runs when `if` is
false.
Built-ins: `state.set | patch | push | remove | toggle`, `ui.patch`, `http`
(same-origin by default, `http.allowHosts` for more), `delay`, `emit` (to
the host), `call` (a named spec action, with `$args`), `seq`, `all`, `log`.
Host actions merge over them:

```ts
<UIView actions={{ 'cart.add': async (args, ctx) => { … } }} helpers={{ money: ([n]) => … }} … />
```

Concurrency per node and event: `drop` (default — a second press while one
runs is ignored), `restart` (default for `input`), `queue`, `parallel`; set
it with `"on": { "press": { "mode": "queue", "steps": [ … ] } }`. Every
node sees `$pending` while its action runs. Unmounting aborts everything;
after an abort nothing is written.

## The catalog

`baseCatalog` has eight components — `stack`, `text`, `button`, `input`,
`image`, `list`, `card`, `divider` — the built-in actions and the default
helpers. Extend it:

```ts
const catalog = defineCatalog({
    extends: baseCatalog,
    components: { chart: { description: 'A line chart', props: { series: { type: 'array', required: true } } } }
});
const registry = webRegistry({ chart: (p) => jsx(LineChart, { series: p.series }) });
```

From a catalog: `validateSpec(spec, catalog, { mode })` (`streaming` is
tolerant, `final` strict), `uiSpecSchema(catalog)` (a Standard Schema),
`specJsonSchema(catalog)` (the loose recursive schema a model is asked to
follow) and `describeCatalog(catalog)` (the prompt section). `uiTool()`
bundles them into a tool.

## Streaming without the tool loop

`applyUIChunk(doc, chunk)` folds `text` deltas, pre-parsed `spec`
partials, `patch` lists (`replace | append | remove | props` by id,
`state` by path), `finish` and `error` into a document, in place, on a
plain object or a reactive one. `createUIRuntime()` wraps a document with
state, computed values and the action runner; `<UIView runtime={rt} />`
renders it while `rt.apply(chunk)` feeds it from any source.

## Platforms

Nothing in the core or the renderer touches the DOM. A registry maps
catalog types to sigx components or plain functions built with `jsx()` and
string tags; the web pack uses `div` / `span` / `button` / `input` and
`onClick` / `onInput`. A Lynx pack is the same eight functions over
`view` / `text` / `image` / `input` and `onTap` — the spec does not change.
