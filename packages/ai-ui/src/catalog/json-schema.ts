/**
 * The JSON Schema a model is asked to follow. Deliberately LOOSE: a
 * recursive node with `type` restricted to the catalog and `props` an open
 * object. Per-component prop rules live in the prompt section and are
 * enforced by `validateSpec` — a recursive `oneOf` per component is not
 * portable across providers' strict modes, and a model that knows the
 * prompt rarely needs the schema to say more.
 *
 * Property ORDER matters: `type` first, `children` last, so a streaming
 * node names its component before its subtree arrives.
 */

import type { JsonSchema } from '@sigx/ai';
import type { UICatalog } from './define-catalog.js';

export function specJsonSchema(catalog: UICatalog): JsonSchema {
    const types = Object.keys(catalog.components);
    return {
        type: 'object',
        properties: {
            version: { const: 1 },
            state: { type: 'object', description: 'Initial state, a JSON object.', additionalProperties: true },
            computed: { type: 'object', description: 'Derived values by name.', additionalProperties: { $ref: '#/$defs/expr' } },
            actions: { type: 'object', description: 'Named step lists, run with { "do": "call", "action": "<name>" }.', additionalProperties: { type: 'array', items: { $ref: '#/$defs/step' } } },
            root: { $ref: '#/$defs/node' }
        },
        required: ['root'],
        additionalProperties: false,
        $defs: {
            expr: {
                type: 'object',
                description: 'A dynamic value: { "$": "<expression>" }.',
                properties: { $: { type: 'string' } },
                required: ['$'],
                additionalProperties: false
            },
            step: {
                type: 'object',
                description: 'An action step: "do" names the action, other keys are its arguments.',
                properties: {
                    do: { type: 'string', enum: Object.keys(catalog.actions) },
                    if: { $ref: '#/$defs/expr' },
                    as: { type: 'string', description: 'Bind the result to this name for later steps.' },
                    catch: { type: 'array', items: { $ref: '#/$defs/step' } }
                },
                required: ['do'],
                additionalProperties: true
            },
            node: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: types },
                    id: { type: 'string', description: 'Optional; set it on nodes you may want to patch later.' },
                    props: { type: 'object', additionalProperties: true },
                    if: { $ref: '#/$defs/expr' },
                    for: {
                        type: 'object',
                        properties: {
                            items: { $ref: '#/$defs/expr' },
                            as: { type: 'string' },
                            index: { type: 'string' },
                            key: { $ref: '#/$defs/expr' }
                        },
                        required: ['items'],
                        additionalProperties: false
                    },
                    bind: { type: 'string', description: 'A state path the value is two-way bound to.' },
                    on: {
                        type: 'object',
                        additionalProperties: { type: 'array', items: { $ref: '#/$defs/step' } }
                    },
                    children: { type: 'array', items: { $ref: '#/$defs/node' } }
                },
                required: ['type'],
                additionalProperties: false
            }
        }
    };
}
