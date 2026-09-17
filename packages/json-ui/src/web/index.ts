/**
 * @sigx/json-ui/web — the base catalog on the web: eight plain functions over
 * `jsx('div' | 'span' | 'button' | 'input' | 'img' | 'hr', …)`. No DOM API
 * is touched here, only string tags and `on*` props, so it type-checks
 * without `@sigx/runtime-dom` and runs wherever those tags mean HTML.
 *
 * The pack owns the platform mapping: `onClick` → `press`, `onInput` →
 * `input { value }`, Enter → `submit`. Styles are objects (the spec's rule)
 * merged over the pack's own layout styles; `webStyles` is the stylesheet
 * a host injects once.
 */

import { jsx, type JSXElement } from '@sigx/runtime-core';
import type { UIComponentProps, UIRegistry } from '../app/registry.js';

type Style = Record<string, string | number>;

const str = (v: unknown, fallback = ''): string => (v == null ? fallback : typeof v === 'string' ? v : String(v));
const px = (v: unknown): string | undefined => (typeof v === 'number' ? `${v}px` : typeof v === 'string' ? v : undefined);
const styleOf = (v: unknown): Style => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Style) : {});
const classes = (...parts: unknown[]): string => parts.filter((p) => typeof p === 'string' && p).join(' ');

const FLEX_ALIGN: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };
const FLEX_JUSTIFY: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around' };

function flex(p: UIComponentProps, extra: Style = {}): Style {
    const s: Style = { display: 'flex', flexDirection: p.direction === 'row' ? 'row' : 'column' };
    if (typeof p.gap === 'number') s.gap = `${p.gap}px`;
    if (typeof p.align === 'string' && FLEX_ALIGN[p.align]) s.alignItems = FLEX_ALIGN[p.align]!;
    if (typeof p.justify === 'string' && FLEX_JUSTIFY[p.justify]) s.justifyContent = FLEX_JUSTIFY[p.justify]!;
    if (p.wrap === true) s.flexWrap = 'wrap';
    if (typeof p.padding === 'number') s.padding = `${p.padding}px`;
    return { ...s, ...extra, ...styleOf(p.style) };
}

const press = (p: UIComponentProps): Record<string, unknown> => (p.on.press ? { onClick: () => p.on.press?.({ type: 'press' }) } : {});

const TEXT_TAG: Record<string, string> = { heading: 'h2', title: 'h3' };

export const webComponents: Record<string, (p: UIComponentProps) => JSXElement> = {
    stack: (p) => jsx('div', { class: classes('json-ui-stack', p.class), style: flex(p), children: p.children }),

    text: (p) => {
        const variant = str(p.variant, 'body');
        const style: Style = { ...styleOf(p.style) };
        if (typeof p.color === 'string') style.color = p.color;
        if (typeof p.align === 'string') style.textAlign = p.align === 'end' ? 'right' : p.align === 'center' ? 'center' : 'left';
        return jsx(TEXT_TAG[variant] ?? 'span', { class: classes('json-ui-text', `json-ui-text--${variant}`, p.class), style, ...press(p), children: str(p.text) });
    },

    button: (p) =>
        jsx('button', {
            type: 'button',
            class: classes('json-ui-button', `json-ui-button--${str(p.variant, 'primary')}`, p.size ? `json-ui-button--${str(p.size)}` : '', p.pending ? 'is-pending' : '', p.class),
            style: styleOf(p.style),
            disabled: p.disabled === true || p.pending,
            ...press(p),
            children: str(p.label)
        }),

    input: (p) => {
        const field = jsx('input', {
            class: classes('json-ui-input', p.class),
            style: styleOf(p.style),
            type: str(p.kind, 'text'),
            placeholder: str(p.placeholder),
            disabled: p.disabled === true,
            value: str(p.model?.value),
            onInput: (e: { target: { value: string } }) => {
                const value = e.target.value;
                p.model?.set(value);
                p.on.input?.({ type: 'input', value });
            },
            onKeyDown: (e: { key: string; target: { value: string } }) => {
                if (e.key === 'Enter') p.on.submit?.({ type: 'submit', value: e.target.value });
            }
        });
        if (typeof p.label === 'string' && p.label) {
            return jsx('label', { class: 'json-ui-field', children: [jsx('span', { class: 'json-ui-field__label', children: p.label }), field] });
        }
        return field;
    },

    image: (p) =>
        jsx('img', {
            class: classes('json-ui-image', p.class),
            src: str(p.src),
            alt: str(p.alt),
            width: typeof p.width === 'number' ? p.width : undefined,
            height: typeof p.height === 'number' ? p.height : undefined,
            style: { ...(typeof p.fit === 'string' ? { objectFit: p.fit } : {}), ...(px(p.width) ? { width: px(p.width)! } : {}), ...(px(p.height) ? { height: px(p.height)! } : {}), ...styleOf(p.style) }
        }),

    list: (p) => jsx('div', { class: classes('json-ui-list', p.class), style: flex(p), children: p.children }),

    card: (p) => {
        const style: Style = { ...(typeof p.padding === 'number' ? { padding: `${p.padding}px` } : {}), ...styleOf(p.style) };
        const children: JSXElement[] = [];
        if (typeof p.title === 'string' && p.title) children.push(jsx('div', { class: 'json-ui-card__title', children: p.title }));
        children.push(jsx('div', { class: 'json-ui-card__body', children: p.children }));
        return jsx('div', { class: classes('json-ui-card', p.class), style, children });
    },

    divider: (p) => jsx('hr', { class: classes('json-ui-divider', p.class), style: styleOf(p.style) })
};

/** The base catalog's web implementations. Spread and override to customise. */
export function webRegistry(overrides: UIRegistry = {}): UIRegistry {
    return { ...webComponents, ...overrides };
}

/** A small stylesheet for the base components; inject once (a `<style>` tag, `useHead`). */
export const webStyles = `
.json-ui-stack, .json-ui-list { min-width: 0; }
.json-ui-text { display: block; margin: 0; line-height: 1.4; }
.json-ui-text--heading { font-size: 1.35rem; font-weight: 650; }
.json-ui-text--title { font-size: 1.1rem; font-weight: 600; }
.json-ui-text--caption { font-size: 0.85em; opacity: 0.7; }
.json-ui-text--label { font-size: 0.85em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; }
.json-ui-button { font: inherit; border-radius: 8px; padding: 0.45em 0.9em; border: 1px solid transparent; cursor: pointer; }
.json-ui-button--primary { background: #2563eb; color: #fff; }
.json-ui-button--secondary { background: #e5e7eb; color: #111; }
.json-ui-button--ghost { background: transparent; border-color: currentColor; }
.json-ui-button--danger { background: #dc2626; color: #fff; }
.json-ui-button--sm { font-size: 0.85em; padding: 0.3em 0.7em; }
.json-ui-button--lg { font-size: 1.1em; padding: 0.6em 1.2em; }
.json-ui-button:disabled { opacity: 0.55; cursor: default; }
.json-ui-input { font: inherit; padding: 0.45em 0.6em; border: 1px solid #cbd5e1; border-radius: 8px; width: 100%; box-sizing: border-box; }
.json-ui-field { display: flex; flex-direction: column; gap: 4px; }
.json-ui-field__label { font-size: 0.85em; opacity: 0.8; }
.json-ui-card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px; background: #fff; }
.json-ui-card__title { font-weight: 600; margin-bottom: 8px; }
.json-ui-card__body { display: flex; flex-direction: column; gap: 8px; }
.json-ui-divider { border: 0; border-top: 1px solid #e2e8f0; margin: 4px 0; width: 100%; }
.json-ui-image { max-width: 100%; border-radius: 8px; }
`;
