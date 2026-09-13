/** Stream helpers for the process tests. */

export async function collectText(readable: ReadableStream<Uint8Array>): Promise<string> {
    const decoder = new TextDecoder();
    let out = '';
    for await (const chunk of readable as unknown as AsyncIterable<Uint8Array>) out += decoder.decode(chunk, { stream: true });
    return out + decoder.decode();
}

export async function writeText(writable: WritableStream<Uint8Array>, text: string, close = false): Promise<void> {
    const writer = writable.getWriter();
    await writer.write(new TextEncoder().encode(text));
    if (close) await writer.close();
    writer.releaseLock();
}
