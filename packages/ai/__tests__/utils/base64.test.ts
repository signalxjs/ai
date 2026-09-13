import { describe, it, expect } from 'vitest';
import { encodeBase64, decodeBase64 } from '@sigx/ai';

describe('base64', () => {
    it('round-trips bytes, including multi-byte UTF-8 and every byte value', () => {
        const text = new TextEncoder().encode('héllo 🚀 — ok');
        expect(new TextDecoder().decode(decodeBase64(encodeBase64(text)))).toBe('héllo 🚀 — ok');
        const all = new Uint8Array(256).map((_, i) => i);
        expect(decodeBase64(encodeBase64(all))).toEqual(all);
    });

    it('handles the empty input', () => {
        expect(encodeBase64(new Uint8Array())).toBe('');
        expect(decodeBase64('')).toEqual(new Uint8Array());
    });

    it('matches the platform encoding on small inputs and survives chunking on large ones', () => {
        const bytes = new TextEncoder().encode('Man');
        expect(encodeBase64(bytes)).toBe('TWFu');
        const big = new Uint8Array(100_003).map((_, i) => (i * 31) % 256);
        const encoded = encodeBase64(big);
        expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
        expect(decodeBase64(encoded)).toEqual(big);
    });
});
