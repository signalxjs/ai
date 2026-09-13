/**
 * `AskUserQuestion` → an input request, and the answers back.
 *
 * The CLI's own question tool is the one place Claude Code asks the operator
 * something that is not a permission, so it reaches the policy as
 * `kind: 'input'` instead of "may this tool run". The answers travel back
 * through `canUseTool`'s `updatedInput`: the tool reads an `answers` map
 * keyed by question TEXT off its own input and resolves with it, so an
 * allowed call with answers reports "The user answered: …" and an allowed
 * call without them reports "The user did not answer the questions." —
 * verified against the real CLI, no TTY. Nothing is denied for a question the
 * operator actually answered.
 */

import type { JsonSchema } from '@sigx/ai';
import type { RequestOption } from '@sigx/ai-agent';

/** The CLI's built-in question tool. */
export const ASK_USER_QUESTION = 'AskUserQuestion';

/** One question as `AskUserQuestionInput` carries it. */
export interface AskQuestion {
    readonly question: string;
    readonly header: string;
    readonly options: readonly { readonly label: string; readonly description?: string }[];
    readonly multiSelect: boolean;
}

/** The property name a question answers under — positional, since the tool gives questions no id. */
export function questionId(index: number): string {
    return `q${index + 1}`;
}

/** `AskUserQuestion`'s input, or `undefined` when it is not the shape we know. */
export function parseQuestions(input: unknown): readonly AskQuestion[] | undefined {
    if (typeof input !== 'object' || input === null) return undefined;
    const raw = (input as { questions?: unknown }).questions;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const out: AskQuestion[] = [];
    for (const q of raw) {
        if (typeof q !== 'object' || q === null) return undefined;
        const { question, header, options, multiSelect } = q as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
        if (typeof question !== 'string' || question === '') return undefined;
        const choices: { label: string; description?: string }[] = [];
        for (const o of Array.isArray(options) ? options : []) {
            if (typeof o !== 'object' || o === null) continue;
            const { label, description } = o as { label?: unknown; description?: unknown };
            if (typeof label === 'string' && label !== '') choices.push({ label, ...(typeof description === 'string' ? { description } : {}) });
        }
        // `header` is display text — an empty one would render a blank legend, so the question stands in.
        out.push({ question, header: typeof header === 'string' && header !== '' ? header : question, options: choices, multiSelect: multiSelect === true });
    }
    return out;
}

/**
 * One property per question, keyed by `questionId`. The options are offered as
 * an `enum` branch, but the tool always accepts a free-text "Other" — so the
 * branch sits under `anyOf` beside an open string rather than closing the
 * value to the listed labels.
 */
export function questionsSchema(questions: readonly AskQuestion[]): JsonSchema {
    const properties: Record<string, JsonSchema> = {};
    for (const [i, q] of questions.entries()) {
        const labels = q.options.map((o) => o.label);
        const value: JsonSchema = { type: 'string', ...(labels.length ? { anyOf: [{ enum: labels }, { type: 'string' }] } : {}) };
        properties[questionId(i)] = q.multiSelect
            ? { type: 'array', title: q.header, description: q.question, items: value }
            : { ...value, title: q.header, description: q.question };
    }
    return { type: 'object', properties, required: questions.map((_, i) => questionId(i)), additionalProperties: false };
}

/** Every option of every question, flattened for a client that only renders a flat list. */
export function questionOptions(questions: readonly AskQuestion[]): RequestOption[] {
    return questions.flatMap((q, i) => q.options.map((o) => ({ id: `${questionId(i)}:${o.label}`, label: o.label, ...(o.description !== undefined ? { description: o.description } : {}) })));
}

/** The questions as one block of text, for a client that renders no form at all. */
export function questionsMessage(questions: readonly AskQuestion[]): string {
    return questions.map((q) => `${q.header}: ${q.question}`).join('\n');
}

/**
 * `{ q1: 'A', q2: ['B', 'C'] }` → the tool's own `answers` map, keyed by
 * question text with multi-select answers comma-separated. Unanswered
 * questions are left out: the tool reports exactly what it was given.
 */
export function toAskAnswers(questions: readonly AskQuestion[], given: unknown): Record<string, string> {
    const source = typeof given === 'object' && given !== null ? (given as Record<string, unknown>) : {};
    const answers: Record<string, string> = {};
    for (const [i, q] of questions.entries()) {
        const value = source[questionId(i)];
        const text = Array.isArray(value) ? value.filter((v) => v !== undefined && v !== null && v !== '').map(String).join(', ') : value === undefined || value === null ? '' : String(value);
        if (text !== '') answers[q.question] = text;
    }
    return answers;
}
