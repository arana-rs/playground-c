import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { runProject, runRead } from './adapters.ts';
import type { RunOptions, RunResult } from './adapters.ts';

export type { RunMetrics, RunOptions, RunResult } from './adapters.ts';
export type { Diagnostic, ExecuteIOOptions, ExecuteOptions, PrepareOptions, SourceFile, SourceProject, VirtualInputFile } from './core/index.ts';

/** Read a filesystem path as UTF-8, then prepare and synchronously execute its source. */
export function runFile(path: string, options?: RunOptions): Promise<RunResult> {
    const name = typeof path === 'string' && path.length > 0 ? basename(path) : 'source.c';
    return runRead(name, async () => {
        if (typeof path !== 'string' || path.length === 0) {
            throw new TypeError('Expected a non-empty filesystem path.');
        }
        return readFile(path, { encoding: 'utf8', signal: options?.signal });
    }, options);
}

/** Run a supplied virtual project without reading files from the host filesystem. */
export { runProject };
