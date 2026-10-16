import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { RUN_CONFIGURATION } from '../src/execution/configuration.ts';

const root = await mkdtemp(join(tmpdir(), 'c-playground-run-c-'));
const cli = fileURLToPath(new URL('../scripts/run-c.ts', import.meta.url));

after(async () => rm(root, { recursive: true, force: true }));

async function sourceFile(name, source) {
  const path = join(root, name);
  await writeFile(path, source, 'utf8');
  return path;
}

function runCli(args, input) {
  const child = spawn(process.execPath, ['--experimental-strip-types', cli, ...args], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdin.end(input);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

test('CLI preserves UTF-8 output bytes and returns the C exit status for a spaced path', async () => {
  const path = await sourceFile('archivo ñ con espacios.c', String.raw`#include <stdio.h>
int main(void) { printf("salida:\303\261\n"); fprintf(stderr, "aviso\n"); return 7; }
`);
  const result = await runCli([path]);
  assert.equal(result.code, 7, result.stderr.toString('utf8'));
  assert.equal(result.stdout.toString('utf8'), 'salida:ñ\n');
  assert.equal(result.stderr.toString('utf8'), 'aviso\n');
});

test('CLI accepts piped scanf input that arrives before the engine asks for it', async () => {
  const path = await sourceFile('piped.c', '#include <stdio.h>\nint main(void) { int value = 0; if (scanf("%d", &value) != 1) return 1; printf("valor:%d\\n", value); return 0; }\n');
  const result = await runCli([path], '42\n');
  assert.equal(result.code, 0, result.stderr.toString('utf8'));
  assert.equal(result.stdout.toString('utf8'), 'valor:42\n');
  assert.equal(result.stderr.byteLength, 0);
});

test('CLI flushes a scanf prompt and pauses its active watchdog while stdin waits', async () => {
  const path = await sourceFile('interactive.c', '#include <stdio.h>\nint main(void) { int value = 0; printf("valor? "); if (scanf("%d", &value) != 1) return 1; printf("%d\\n", value); return 0; }\n');
  const child = spawn(process.execPath, ['--experimental-strip-types', cli, path], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const timeout = setTimeout(() => child.kill('SIGKILL'), RUN_CONFIGURATION.timeoutMs + 5_000);
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve([code, signal]));
  });

  let promptTimeout;
  let firstOutput;
  try {
    firstOutput = await Promise.race([
      new Promise(resolve => child.stdout.once('data', resolve)),
      new Promise((_, reject) => { promptTimeout = setTimeout(() => reject(new Error('prompt was not flushed while stdin was waiting')), 3_000); }),
    ]);
  } catch (error) {
    child.kill('SIGKILL');
    await closed;
    clearTimeout(timeout);
    throw error;
  }
  clearTimeout(promptTimeout);
  assert.equal(firstOutput.toString('utf8'), 'valor? ');
  await new Promise(resolve => setTimeout(resolve, RUN_CONFIGURATION.timeoutMs + 250));
  child.stdin.end('9\n');
  const [code, signal] = await closed;
  clearTimeout(timeout);
  assert.equal(signal, null);
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  assert.equal(Buffer.concat(stdout).toString('utf8'), 'valor? 9\n');
  assert.equal(Buffer.concat(stderr).byteLength, 0);
});

test('CLI delivers EOF to an interactive scanf session instead of hanging', async () => {
  const path = await sourceFile('eof.c', '#include <stdio.h>\nint main(void) { int value; if (scanf("%d", &value) == EOF) { puts("eof"); return 4; } return 0; }\n');
  const result = await runCli([path], '');
  assert.equal(result.code, 4);
  assert.equal(result.stdout.toString('utf8'), 'eof\n');
});

test('CLI maps C diagnostics to stderr with the virtual main.c name', async () => {
  const path = await sourceFile('invalid.c', 'int main(void) { int value = 1 return value; }\n');
  const result = await runCli([path]);
  assert.equal(result.code, 1);
  assert.match(result.stderr.toString('utf8'), /main\.c:\d+:\d+: [A-Z0-9_]+:/);
});

test('CLI reports missing files and invalid usage with conventional exit codes', async () => {
  const missing = await runCli([join(root, 'does not exist.c')]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr.toString('utf8'), /no se pudo leer/);

  const usage = await runCli([]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr.toString('utf8'), /Uso: pnpm run-c/);

  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout.toString('utf8'), /entrada virtual se llama main\.c/);
});

test('CLI prints the engine instruction-limit diagnostic instead of hanging', async () => {
  const path = await sourceFile('limit.c', 'int main(void) { for (;;) { } }\n');
  const result = await runCli([path]);
  assert.equal(result.code, 1);
  assert.match(result.stderr.toString('utf8'), /LIMIT_EXCEEDED:.*maxInstructions/);
});
