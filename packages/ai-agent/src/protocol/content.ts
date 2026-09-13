/**
 * Content — what a prompt is made of, and what a tool result can carry.
 *
 * `PromptPart` fields mirror `@sigx/ai`'s user-message parts (text, image,
 * file) so a prompt passes straight into `toModelMessages` once the core
 * carries image and file parts; `resource` is the harness-side extra (an
 * MCP resource or a file reference by URI). Binary data is base64 text so
 * every part is plain JSON.
 */

export interface TextPart {
    readonly type: 'text';
    readonly text: string;
}

export interface ImagePart {
    readonly type: 'image';
    /** An IANA media type, e.g. `image/png`. */
    readonly mediaType: string;
    /** Base64 payload — exactly one of `data` / `url`. */
    readonly data?: string;
    readonly url?: string;
}

export interface FilePart {
    readonly type: 'file';
    readonly mediaType: string;
    /** Base64 payload — exactly one of `data` / `url`. */
    readonly data?: string;
    readonly url?: string;
    readonly filename?: string;
}

export interface ResourcePart {
    readonly type: 'resource';
    readonly uri: string;
    readonly mediaType?: string;
    /** Inline text content when the resource was embedded. */
    readonly text?: string;
    readonly name?: string;
}

export type PromptPart = TextPart | ImagePart | FilePart | ResourcePart;

/** A prompt: a string is shorthand for one text part. */
export type PromptInput = string | ReadonlyArray<PromptPart>;

export function toPromptParts(input: PromptInput): PromptPart[] {
    return typeof input === 'string' ? [{ type: 'text', text: input }] : [...input];
}

/** The text of a prompt or message — its text parts joined. */
export function partsText(parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>): string {
    let out = '';
    for (const p of parts) if (p.type === 'text' && typeof p.text === 'string') out += p.text;
    return out;
}

/** A structured tool result or a harness-defined block inside one. */
export type ContentBlock =
    | TextPart
    | { readonly type: 'json'; readonly value: unknown }
    | ImagePart
    | ResourcePart
    | { readonly type: 'ext'; readonly ns: string; readonly name: string; readonly data: unknown };
