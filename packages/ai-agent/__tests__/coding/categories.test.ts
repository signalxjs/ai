import { describe, it, expect } from 'vitest';
import { CODING_CATEGORIES, isCodingCategory, categoryOf } from '@sigx/ai-agent/coding';

describe('coding categories', () => {
    it('lists the ACP-aligned categories', () => {
        expect(CODING_CATEGORIES).toEqual(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'think', 'other']);
        expect(isCodingCategory('edit')).toBe(true);
        expect(isCodingCategory('write')).toBe(false);
    });

    it('maps common native tool names, case-insensitively, including MCP-style names', () => {
        expect(categoryOf('Read')).toBe('read');
        expect(categoryOf('Glob')).toBe('read');
        expect(categoryOf('Grep')).toBe('search');
        expect(categoryOf('MultiEdit')).toBe('edit');
        expect(categoryOf('Write')).toBe('edit');
        expect(categoryOf('Bash')).toBe('execute');
        expect(categoryOf('commandExecution')).toBe('execute');
        expect(categoryOf('WebFetch')).toBe('fetch');
        expect(categoryOf('TodoWrite')).toBe('think');
        expect(categoryOf('Task')).toBe('other');
        expect(categoryOf('mcp__fs__read_file')).toBe('read');
        expect(categoryOf('server/rename')).toBe('move');
        expect(categoryOf('something_else')).toBeUndefined();
    });
});
