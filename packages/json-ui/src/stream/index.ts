/** The stream protocol: chunks, the document, and the reducer that folds one into the other. */

export type { UIStreamChunk, UIDocument, UIDocumentStatus } from './chunk.js';
export { createDocument } from './chunk.js';
export { mergeDeep } from './merge.js';
export { applyPatch } from './patch.js';
export type { ReduceOptions } from './reduce.js';
export { applyUIChunk, assembleSpec } from './reduce.js';
