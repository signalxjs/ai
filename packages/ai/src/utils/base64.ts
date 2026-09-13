/**
 * Base64 without `Buffer` — `btoa` / `atob` exist on every WinterCG runtime
 * and every browser this package targets, so image and file bytes become the
 * plain-JSON `data` of a part anywhere.
 */

const CHUNK = 0x8000;

/** Bytes → standard base64 (with padding). Chunked so a large image does not blow the argument limit of `String.fromCharCode`. */
export function encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return btoa(binary);
}

/** Standard base64 → bytes. */
export function decodeBase64(text: string): Uint8Array {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}
