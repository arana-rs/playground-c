import { runFile as runBrowserFile } from '@playground/c11-engine/browser';
import { runFile as runNodeFile } from '@playground/c11-engine/node';
import type { RunOptions, RunResult } from '@playground/c11-engine/browser';

const options: RunOptions = {
    signal: new AbortController().signal,
    prepare: { limits: { maxTokens: null } },
    execute: { limits: { maxInstructions: 1000 } },
};
const browser: Promise<RunResult> = runBrowserFile(new File([''], 'main.c'), options);
const node: Promise<RunResult> = runNodeFile('./main.c', options);
const result = await node;
if (result.kind === 'terminated') {
    const code: number = result.exitCode;
    void code;
} else {
    const message: string = result.diagnostics[0].message;
    void message;
}
void browser;
