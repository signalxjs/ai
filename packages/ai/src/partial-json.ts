/**
 * `parsePartialJson` — the best complete value a JSON prefix can be read as.
 *
 * A streaming model emits a document one token at a time; a UI that wants to
 * render `{ title: "Hel` as `{ title: "Hel" }` needs the prefix repaired:
 * open strings closed, dangling keys/colons/commas dropped, open arrays and
 * objects closed, an incomplete literal (`tru`, `nul`, `-1.`) trimmed. The
 * repair is structural — a scanner that tracks the bracket stack and
 * whether it is inside a string — so it is O(n) and never guesses at
 * semantics.
 *
 * Returns `undefined` when nothing parseable exists yet (empty input, or a
 * prefix that is only whitespace or a lone `"`).
 */
export function parsePartialJson(text: string): unknown {
    const trimmed = text.trimStart();
    if (!trimmed) return undefined;
    try {
        return JSON.parse(trimmed);
    } catch {
        // fall through to repair
    }
    const repaired = repair(trimmed);
    if (repaired === undefined) return undefined;
    try {
        return JSON.parse(repaired);
    } catch {
        return undefined;
    }
}

function repair(src: string): string | undefined {
    const stack: ('{' | '[')[] = [];
    let inString = false;
    let escaped = false;
    // Index just past the last position at which the document was in a
    // "complete value" state within the current container.
    let out = '';
    for (let i = 0; i < src.length; i++) {
        const ch = src[i]!;
        out += ch;
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{' || ch === '[') stack.push(ch);
        else if (ch === '}' || ch === ']') stack.pop();
    }

    if (inString) {
        // A trailing backslash would escape our closing quote — drop it.
        if (escaped) out = out.slice(0, -1);
        out += '"';
    }

    // Now trim anything that cannot be completed: trailing `,`, a key with
    // no value (`"k"` or `"k":` inside an object), a partial literal.
    for (;;) {
        const before = out;
        out = out.replace(/\s+$/, '');
        // partial literals / numbers at the end of the current value. No
        // lookbehind: the separator prefix is captured and kept, so this runs
        // on every engine rather than only those with variable-length lookbehind.
        out = out.replace(/([:[,]\s*)(?:-|-?\d+\.|-?\d*\.\d*[eE][+-]?|t|tr|tru|f|fa|fal|fals|n|nu|nul)$/, '$1');
        out = out.replace(/\s+$/, '');
        // dangling colon or comma
        out = out.replace(/[:,]$/, '');
        out = out.replace(/\s+$/, '');
        // a key without a value: `{"a":1,"b"` or `{"b"` → drop the key
        const top = stack[stack.length - 1];
        if (top === '{') {
            const m = /(?:^|[{,])\s*"(?:[^"\\]|\\.)*"$/.exec(out);
            if (m) {
                out = out.slice(0, m.index + (m[0].startsWith('{') ? 1 : 0));
                out = out.replace(/,\s*$/, '');
            }
        }
        if (out === before) break;
    }

    for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
    if (!out || out === '"') return undefined;
    return out;
}
