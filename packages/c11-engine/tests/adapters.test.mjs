import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { CAPABILITIES, execute, prepare } from '@playground/c11-engine/core';
import { runFile as runBrowserFile } from '@playground/c11-engine/browser';
import { runFile as runNodeFile } from '@playground/c11-engine/node';
import { fixtureSourceFor } from './p4-test-helpers.mjs';

const SOURCE = 'int main(void) { int x = 6; return x * 7; }';

function assertMetrics(result) {
    for (const key of [
        'readMs', 'prepareMs', 'executeMs', 'totalMs',
        'sourceChars', 'tokenCount', 'instructionCount', 'peakMemoryBytes',
    ]) {
        assert.ok(Number.isFinite(result.metrics[key]), `${key} is finite`);
        assert.ok(result.metrics[key] >= 0, `${key} is non-negative`);
    }
    assert.ok(result.metrics.totalMs >= result.metrics.readMs);
    assert.ok(result.metrics.totalMs >= result.metrics.prepareMs + result.metrics.executeMs);
}

async function temporaryFile(t, source, filename = 'main.c') {
    const directory = await mkdtemp(join(tmpdir(), 'c11-engine-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, filename);
    await writeFile(path, source, 'utf8');
    return path;
}

test('the built public browser entry accepts File and separates timings', async () => {
    const result = await runBrowserFile(new File([SOURCE], 'memoria-ñ.c'));
    assert.equal(result.kind, 'terminated');
    assert.equal(result.exitCode, 42);
    assert.equal(result.mainReturn, 42);
    assert.equal(result.rawExitStatus, 42);
    assert.equal(result.metrics.sourceChars, SOURCE.length);
    assert.ok(result.metrics.tokenCount > 0);
    assert.ok(result.metrics.instructionCount > 0);
    assertMetrics(result);
});

test('the built public Node entry accepts a real Unicode filesystem path', async (t) => {
    const path = await temporaryFile(t, SOURCE, 'cálculo ñ.c');
    const result = await runNodeFile(path);
    assert.equal(result.kind, 'terminated');
    assert.equal(result.exitCode, 42);
    assert.equal(result.metrics.sourceChars, SOURCE.length);
    assertMetrics(result);
});

test('P2 scalar, flow, recursive and math behavior is available through File and path adapters', async (t) => {
    const source = fixtureSourceFor('adapters', 'p2-adapter.c');
    const path = await temporaryFile(t, source, 'p2-cálculo.c');
    for (const result of await Promise.all([
        runBrowserFile(new File([source], 'p2-cálculo.c')),
        runNodeFile(path),
    ])) {
        assert.equal(result.kind, 'terminated', JSON.stringify(result));
        assert.equal(result.mainReturn, 1);
        assert.equal(result.exitCode, 1);
        assert.equal(result.metrics.sourceChars, source.length);
        assert.ok(result.metrics.peakMemoryBytes > 8);
        assertMetrics(result);
    }
});

test('File and path runs preserve Linux exit status separately from main return', async (t) => {
    const source = 'int main(void) { return -1; }';
    const path = await temporaryFile(t, source);
    for (const result of await Promise.all([
        runBrowserFile(new File([source], 'main.c')),
        runNodeFile(path),
    ])) {
        assert.equal(result.kind, 'terminated');
        assert.equal(result.exitCode, 255);
        assert.equal(result.mainReturn, -1);
        assert.equal(result.rawExitStatus, -1);
    }
});

test('Node read errors have their own category and never manufacture an exit code', async (t) => {
    const path = await temporaryFile(t, SOURCE);
    const result = await runNodeFile(`${path}.missing`);
    assert.equal(result.kind, 'read-error');
    assert.equal(result.diagnostics[0].code, 'READ_FAILED');
    assert.equal(result.diagnostics[0].file, 'main.c.missing');
    assert.equal('exitCode' in result, false);
    assert.equal(result.metrics.prepareMs, 0);
    assert.equal(result.metrics.executeMs, 0);
    assertMetrics(result);
});

test('a browser read error is distinct from a preparation failure', async () => {
    class BrokenFile extends File {
        async text() { throw new Error('test read failure'); }
    }
    const result = await runBrowserFile(new BrokenFile([SOURCE], 'broken.c'));
    assert.equal(result.kind, 'read-error');
    assert.match(result.diagnostics[0].message, /test read failure/);
    assert.equal(result.metrics.tokenCount, 0);
    assertMetrics(result);
});

test('unsupported language features preserve preparation diagnostics and location', async (t) => {
    const source = 'int main(void) {\n    long double value = 1.0L;\n    return 0;\n}';
    const path = await temporaryFile(t, source, 'unsupported.c');
    for (const result of await Promise.all([
        runBrowserFile(new File([source], 'unsupported.c')),
        runNodeFile(path),
    ])) {
        assert.equal(result.kind, 'prepare-error');
        assert.ok(result.diagnostics.length > 0);
        assert.equal(result.diagnostics[0].file, 'unsupported.c');
        assert.equal(result.diagnostics[0].line, 2);
        assert.equal(result.metrics.executeMs, 0);
        assert.equal('exitCode' in result, false);
        assertMetrics(result);
    }
});

test('runtime failures preserve engine diagnostics and preparation metrics', async () => {
    const result = await runBrowserFile(new File(['int main(void) { return 1 / 0; }'], 'zero.c'));
    assert.equal(result.kind, 'runtime-error');
    assert.equal(result.diagnostics[0].file, 'zero.c');
    assert.ok(result.metrics.sourceChars > 0);
    assert.ok(result.metrics.tokenCount > 0);
    assert.equal('exitCode' in result, false);
    assertMetrics(result);
});

test('pre-aborted File and Node calls cancel before any file read', async () => {
    const controller = new AbortController();
    controller.abort();
    class UnreadFile extends File {
        async text() { throw new Error('must not be read'); }
    }
    const options = { signal: controller.signal };
    for (const result of await Promise.all([
        runBrowserFile(new UnreadFile([SOURCE], 'unread.c'), options),
        runNodeFile('/this-file-does-not-exist.c', options),
    ])) {
        assert.equal(result.kind, 'cancelled');
        assert.equal(result.stage, 'read');
        assert.equal(result.metrics.readMs, 0);
        assert.equal(result.metrics.prepareMs, 0);
        assert.equal('exitCode' in result, false);
        assertMetrics(result);
    }
});

test('cancellation arriving during an asynchronous file read prevents preparation', async () => {
    const controller = new AbortController();
    class AbortingFile extends File {
        async text() {
            const source = await super.text();
            controller.abort();
            return source;
        }
    }
    const result = await runBrowserFile(new AbortingFile([SOURCE], 'cancelled.c'), {
        signal: controller.signal,
    });
    assert.equal(result.kind, 'cancelled');
    assert.equal(result.stage, 'prepare');
    assert.equal(result.metrics.prepareMs, 0);
    assertMetrics(result);
});

test('preparation and execution budgets remain individually configurable', async () => {
    const file = new File([SOURCE], 'main.c');
    const preparationLimit = await runBrowserFile(file, {
        prepare: { limits: { maxSourceChars: 1 } },
    });
    assert.equal(preparationLimit.kind, 'limit');
    assert.equal(preparationLimit.resource, 'maxSourceChars');
    assert.equal(preparationLimit.metrics.executeMs, 0);
    const executionLimit = await runBrowserFile(file, {
        execute: { limits: { maxInstructions: 1 } },
    });
    assert.equal(executionLimit.kind, 'limit');
    assert.equal(executionLimit.resource, 'maxInstructions');
    assert.ok(executionLimit.metrics.tokenCount > 0);
    assert.equal('exitCode' in executionLimit, false);
    const unlimited = await runBrowserFile(file, {
        prepare: { limits: { maxSourceChars: null, maxTokens: null, maxDepth: null } },
        execute: { limits: { maxInstructions: null, maxMemoryBytes: null, maxDepth: null } },
    });
    assert.equal(unlimited.kind, 'terminated');
    assert.equal(unlimited.exitCode, 42);
    assertMetrics(preparationLimit);
    assertMetrics(executionLimit);
    assertMetrics(unlimited);
});

test('every File run starts a fresh session, and the public core can reuse preparation', async () => {
    const source = 'int main(void) { int x = 1; x += 1; return x; }';
    const file = new File([source], 'fresh.c');
    const preparation = prepare({ entry: file.name, files: [{ name: file.name, source }] });
    assert.equal(preparation.kind, 'prepared');
    assert.equal(CAPABILITIES.completeC11, false);
    for (let index = 0; index < 3; index += 1) {
        const direct = execute(preparation.program);
        const adapted = await runBrowserFile(file);
        assert.equal(direct.kind, 'terminated');
        assert.equal(adapted.kind, 'terminated');
        assert.equal(direct.exitCode, 2);
        assert.equal(adapted.exitCode, 2);
        assert.equal(direct.metrics.instructionCount, adapted.metrics.instructionCount);
    }
});
