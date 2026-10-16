import { runProject, runRead } from './adapters.ts';
import type { RunOptions, RunResult } from './adapters.ts';

export type { RunMetrics, RunOptions, RunResult } from './adapters.ts';
export type { Diagnostic, ExecuteIOOptions, ExecuteOptions, PrepareOptions, SourceFile, SourceProject, VirtualInputFile } from './core/index.ts';

/** Read a browser File and run a fresh engine session. Run in a Worker for UI isolation. */
export function runFile(file: File, options?: RunOptions): Promise<RunResult> {
    const name = typeof file?.name === 'string' && file.name.length > 0 ? file.name : 'source.c';
    return runRead(name, async () => {
        if (typeof file?.text !== 'function') {
            throw new TypeError('Expected a File with a text() method.');
        }
        return file.text();
    }, options);
}

/** Run a supplied virtual project without consulting the browser filesystem. */
export { runProject };
