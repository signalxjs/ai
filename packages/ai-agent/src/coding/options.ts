/** Session options every coding harness shares; adapters extend them with their own. */

import type { SessionOptions } from '../session/index.js';

export interface CodingSessionOptions extends SessionOptions {
    /** The working directory the agent operates in — an absolute path as the harness's machine sees it. */
    readonly cwd: string;
    /** Further directories the agent may touch. */
    readonly additionalDirectories?: readonly string[];
}
