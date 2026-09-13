/**
 * Base64 without `Buffer` — `btoa` / `atob` exist on every WinterCG runtime
 * and every browser this package targets, so image and file bytes become the
 * plain-JSON `data` of a part anywhere.
 */

const CHUNK = 0x8000;

/** Bytes → standard base64 (with padding). Chunked so a large image does not blow the argument limit of `String.fromCharCode`. */
export function encodeBase64(bytes: Uint8Array): string {
    const pieces: string[] = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
        // `apply` takes any array-like; the typed array goes in without a copy.
        pieces.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
    }
    return btoa(pieces.join(''));
}

/** Standard base64 → bytes. */
export function decodeBase64(text: string): Uint8Array {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}
