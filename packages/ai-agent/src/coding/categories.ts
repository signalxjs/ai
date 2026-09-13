/**
 * Coding categories — a shared vocabulary for what a tool does, aligned with
 * the Agent Client Protocol's tool kinds. The core contract carries
 * `tool-call.category` as an opaque string; this entry gives it names.
 */

export const CODING_CATEGORIES = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'think', 'other'] as const;

export type CodingCategory = (typeof CODING_CATEGORIES)[number];

export function isCodingCategory(value: unknown): value is CodingCategory {
    return typeof value === 'string' && (CODING_CATEGORIES as readonly string[]).includes(value);
}

/** Common native tool names (Claude Code builtins, ACP kinds, Codex item types, shell verbs), lower-cased. */
const BY_NAME: Readonly<Record<string, CodingCategory>> = {
    read: 'read',
    read_file: 'read',
    readfile: 'read',
    cat: 'read',
    view: 'read',
    glob: 'read',
    ls: 'read',
    list_directory: 'read',
    notebookread: 'read',
    grep: 'search',
    search: 'search',
    ripgrep: 'search',
    find: 'search',
    edit: 'edit',
    multiedit: 'edit',
    write: 'edit',
    write_file: 'edit',
    writefile: 'edit',
    edit_file: 'edit',
    apply_patch: 'edit',
    applypatch: 'edit',
    notebookedit: 'edit',
    filechange: 'edit',
    create_file: 'edit',
    delete: 'delete',
    delete_file: 'delete',
    rm: 'delete',
    remove: 'delete',
    move: 'move',
    move_file: 'move',
    mv: 'move',
    rename: 'move',
    bash: 'execute',
    shell: 'execute',
    execute: 'execute',
    exec: 'execute',
    run: 'execute',
    terminal: 'execute',
    commandexecution: 'execute',
    powershell: 'execute',
    webfetch: 'fetch',
    fetch: 'fetch',
    http: 'fetch',
    websearch: 'fetch',
    web_search: 'fetch',
    todowrite: 'think',
    plan: 'think',
    think: 'think',
    switch_mode: 'other',
    task: 'other',
    agent: 'other',
    delegate: 'other'
};

/**
 * The category a common native tool name maps to, or `undefined` for an
 * unknown name. A hint for adapters — the harness's own `kind` wins when it
 * has one. Case-insensitive; an MCP-style `server__tool` name is matched on
 * its last segment.
 */
export function categoryOf(toolName: string): CodingCategory | undefined {
    const lower = toolName.toLowerCase();
    if (BY_NAME[lower]) return BY_NAME[lower];
    const last = lower.split(/__|[/:.]/).pop();
    return last ? BY_NAME[last] : undefined;
}
