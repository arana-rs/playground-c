import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES, DEFAULT_EXECUTE_LIMITS, DEFAULT_PREPARE_LIMITS, ENGINE_VERSION, TARGET_PROFILE, execute, prepare } from '../dist/core/index.js';

const project = (source, name = 'example.c') => ({ entry: name, files: [{ name, source }] });
const prepared = (source, options) => {
  const result = prepare(project(source), options);
  assert.equal(result.kind, 'prepared', JSON.stringify(result));
  return result.program;
};
const run = (body, options) => execute(prepared(`int main(void) { ${body} }`), options);
const terminated = (body, expected, options) => {
  const result = run(body, options);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, expected);
  return result;
};
const preparationError = (source, code = 'UNSUPPORTED_FEATURE') => {
  const result = prepare(project(source));
  assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
  assert.equal(result.diagnostics[0].code, code);
  return result.diagnostics[0];
};
const runtimeError = (body, code) => {
  const result = run(body);
  assert.equal(result.kind, 'runtime-error', JSON.stringify(result));
  assert.equal(result.diagnostics[0].code, code);
  assert.equal('exitCode' in result, false);
  return result.diagnostics[0];
};

test('P1 executes its 42 acceptance example and publishes a truthful versioned target', () => {
  const result = terminated('int x = 6; return x * 7;', 42);
  assert.equal(result.exitCode, 42);
  assert.equal(result.rawExitStatus, 42);
  assert.equal(ENGINE_VERSION, '0.4.0');
  assert.equal(TARGET_PROFILE.id, 'x86_64-linux-lp64');
  assert.equal(TARGET_PROFILE.intBits, 32);
  assert.equal(CAPABILITIES.completeC11, false);
  assert.equal(CAPABILITIES.library, 'partial');
  assert.equal(CAPABILITIES.phase, 'P4');
  assert.ok(Object.isFrozen(CAPABILITIES.operators));
  assert.ok(Object.isFrozen(DEFAULT_PREPARE_LIMITS));
  assert.ok(Object.isFrozen(DEFAULT_EXECUTE_LIMITS));
});

test('arithmetic follows precedence, left associativity, grouping and exact signed division', () => {
  for (const [expression, expected] of [
    ['2 + 3 * 4', 14], ['(2 + 3) * 4', 20], ['18 / 3 / 2', 3], ['10 - 3 - 2', 5],
    ['-7 / 3', -2], ['-7 % 3', -1], ['7 / -3', -2], ['7 % -3', 1],
    ['-(-(+7))', 7], ['-(2 + 3) * -4', 20], ['0x2a + 010', 50],
    ['-2147483647 - 1', -2147483648],
  ]) terminated(`return ${expression};`, expected);
});

test('Linux status keeps the original return and normalizes the exit code to 8 bits', () => {
  assert.equal(terminated('return 256;', 256).exitCode, 0);
  assert.equal(terminated('return -1;', -1).exitCode, 255);
  assert.equal(terminated('return -2147483647 - 1;', -2147483648).exitCode, 0);
  assert.equal(terminated('', 0).exitCode, 0);
});

test('locals, assignments, compounds, expression and empty statements work', () => {
  terminated('int x; x = 7; x += 5; x *= 3; x -= 6; x /= 5; x %= 4; +x; ; return x;', 2);
  terminated('int x = 10; x += x * 2; return x;', 30);
});

test('nested block scopes allow shadowing, release memory and preserve outer assignments', () => {
  const result = terminated('int x = 7; { int x = 4; x += 6; } { int y = 2; x += y; } return x;', 9);
  assert.equal(result.metrics.peakMemoryBytes, 8);
  terminated('{ int x = 1; } { int x = 2; } return 0;', 0, { limits: { maxMemoryBytes: 4 } });
  preparationError('int main(void) { int x; int x; return 0; }', 'REDECLARATION');
  preparationError('int main(void) { { int x = 1; } return x; }', 'UNKNOWN_IDENTIFIER');
});

test('comments and CRLF preserve original file, line and column', () => {
  terminated('/* first\n second */ int x = 6; // hello\r\n return x * 7;', 42);
  const diagnostic = preparationError('int main(void) {\r\n  /* ignored */\r\n  return missing;\r\n}', 'UNKNOWN_IDENTIFIER');
  assert.deepEqual(diagnostic, { code: 'UNKNOWN_IDENTIFIER', message: 'La variable «missing» no está declarada en este ámbito.', file: 'example.c', line: 3, column: 10 });
  const syntax = preparationError('int main(void) {\r\n return 1\r\n}', 'SYNTAX_ERROR');
  assert.equal(syntax.line, 3);
  assert.equal(syntax.column, 1);
  const unclosed = preparationError('int main(void) { /* never closed', 'UNTERMINATED_COMMENT');
  assert.equal(unclosed.column, 18);
});

test('C11 syntax scheduled after P4 is rejected explicitly rather than approximated', () => {
  for (const source of [
    'int main(void){long double x = 1.0L;return 0;}',
    'int main(void){return _Generic(1, int: 2);}',
  ]) preparationError(source);
});

test('translation phases splice logical lines and keep comment contents inert', () => {
  terminated('// comment??/\nreturn 1;\n', 0);
  terminated('// comment\\\nreturn 1;\n', 0);
  terminated('/* ??= */ return 1;', 1);
  terminated('/* x\\\r\ny */ return 1;', 1);
  terminated('// file C:\\example\nreturn 7;', 7);
});

test('syntactically invalid input and missing names receive stage diagnostics', () => {
  for (const source of ['', 'int main(void){return;}', 'int main(void){return (1+2;}', 'int main(void){return 1 + ;}', 'int main(void){return 1 2;}', 'int main(void){']) preparationError(source, 'SYNTAX_ERROR');
  preparationError('int main(void){ x=1; return 0; }', 'UNKNOWN_IDENTIFIER');
  preparationError('int main(void){ return missing; }', 'UNKNOWN_IDENTIFIER');
});

test('indeterminate values, including a self initializer, stop execution', () => {
  runtimeError('int x; return x;', 'UNINITIALIZED_READ');
  runtimeError('int x = x; return 0;', 'UNINITIALIZED_READ');
  runtimeError('int x; x += 1; return x;', 'UNINITIALIZED_READ');
  runtimeError('int x=5; {int x=x;} return 0;', 'UNINITIALIZED_READ');
});

test('all signed arithmetic overflow and zero division are detected', () => {
  for (const expression of ['2147483647 + 1', '(-2147483647 - 1) - 1', '1073741824 * 2', '-(-2147483647 - 1)', '(-2147483647 - 1) / -1', '(-2147483647 - 1) % -1']) runtimeError(`return ${expression};`, 'SIGNED_OVERFLOW');
  runtimeError('int x=2147483647; x+=1; return x;', 'SIGNED_OVERFLOW');
  runtimeError('return 5 / 0;', 'DIVISION_BY_ZERO');
  runtimeError('return 5 % 0;', 'DIVISION_BY_ZERO');
  const diagnostic = runtimeError('return\n 1 / 0;', 'DIVISION_BY_ZERO');
  assert.equal(diagnostic.line, 2);
  assert.equal(diagnostic.column, 4);
});

test('return stops runtime work, but preparation validates unreachable source', () => {
  terminated('return 7; int x; x / 0;', 7);
  terminated('{return 5;} return 8;', 5);
  preparationError('int main(void){return 1; return missing;}', 'UNKNOWN_IDENTIFIER');
  preparationError('int main(void){return 1; long double x;}');
});

test('prepared programs are immutable, validated and each execution uses fresh state', () => {
  const program = prepared('int main(void){int x; x=6; x+=1;return x;}');
  assert.ok(Object.isFrozen(program));
  assert.throws(() => { program.entry = 'changed.c'; }, TypeError);
  for (let count = 0; count < 3; count++) {
    const result = execute(program);
    assert.equal(result.kind, 'terminated');
    assert.equal(result.mainReturn, 7);
    assert.equal(result.metrics.peakMemoryBytes, 4);
  }
  assert.equal(execute({ ...program }).diagnostics[0].code, 'INVALID_PROGRAM');
  assert.equal(execute(structuredClone(program)).kind, 'runtime-error');
});

test('prepared metadata detects resolved malloc calls anywhere in the linked program', () => {
  const direct = prepared('#include <stdlib.h>\nint main(void) { (void)malloc(8); return 0; }');
  assert.equal(direct.hasHeapAllocationCalls, true);

  const uncalledFunction = prepared('#include <stdlib.h>\nvoid allocate(void) { (void)malloc(8); }\nint main(void) { return 0; }');
  assert.equal(uncalledFunction.hasHeapAllocationCalls, true);

  for (const source of [
    'int main(void) { return 0; }',
    '#include <stdlib.h>\nint main(void) { return 0; }',
    '#include <stdlib.h>\nint main(void) { const char *text = "malloc(8)"; /* malloc(4) */ return text[0] == \'x\'; }',
    '#include <stdlib.h>\nint main(void) { free(NULL); return 0; }',
    'void *malloc(unsigned long size) { return 0; }\nint main(void) { return malloc(8) != 0; }',
  ]) {
    assert.equal(prepared(source).hasHeapAllocationCalls, false, source);
  }
});

test('source and token budgets are exact, configurable and can be explicitly disabled', () => {
  const source = 'int main(void){return 42;}';
  const normal = prepare(project(source));
  assert.equal(normal.kind, 'prepared');
  const chars = prepare(project(source), { limits: { maxSourceChars: source.length - 1 } });
  assert.equal(chars.kind, 'limit'); assert.equal(chars.resource, 'maxSourceChars');
  const tokens = prepare(project(source), { limits: { maxTokens: normal.metrics.tokenCount - 1 } });
  assert.equal(tokens.kind, 'limit'); assert.equal(tokens.resource, 'maxTokens');
  assert.equal(prepare(project(source), { limits: { maxTokens: normal.metrics.tokenCount, maxSourceChars: source.length } }).kind, 'prepared');
  assert.equal(prepare(project(source), { limits: { maxSourceChars: null, maxTokens: null, maxDepth: null } }).kind, 'prepared');
});

test('parser limits depth for operators, parentheses and blocks without host stack recursion', () => {
  const samples = [`return ${'1+'.repeat(10000)}1;`, `return ${'-'.repeat(10000)}1;`, `${'{'.repeat(10000)}return 1;${'}'.repeat(10000)}`, `return ${'('.repeat(10000)}1${')'.repeat(10000)};`];
  // Separate adjacent unary '-' tokens so they cannot be tokenized as --.
  samples[1] = `return ${'- '.repeat(10000)}1;`;
  for (const body of samples) {
    const result = prepare(project(`int main(void){${body}}`));
    assert.equal(result.kind, 'limit', JSON.stringify(result));
    assert.equal(result.resource, 'maxDepth');
  }
  const long = prepared(`int main(void){return ${'0+'.repeat(10000)}1;}`, { limits: { maxDepth: null } });
  const result = execute(long, { limits: { maxDepth: null } });
  assert.equal(result.kind, 'terminated'); assert.equal(result.mainReturn, 1);
});

test('execution budgets count actual instructions, object lifetime and expression depth', () => {
  const program = prepared('int main(void){int x=6;return x*7;}');
  const normal = execute(program);
  const instructions = execute(program, { limits: { maxInstructions: normal.metrics.instructionCount - 1 } });
  assert.equal(instructions.kind, 'limit'); assert.equal(instructions.resource, 'maxInstructions');
  assert.equal(execute(program, { limits: { maxInstructions: normal.metrics.instructionCount } }).kind, 'terminated');
  const memory = execute(program, { limits: { maxMemoryBytes: 3 } });
  assert.equal(memory.kind, 'limit'); assert.equal(memory.resource, 'maxMemoryBytes');
  assert.equal(execute(program, { limits: { maxMemoryBytes: 4 } }).kind, 'terminated');
  const depth = execute(program, { limits: { maxDepth: 1 } });
  assert.equal(depth.kind, 'limit'); assert.equal(depth.resource, 'maxDepth');
  const unlimited = execute(program, { limits: { maxInstructions: null, maxMemoryBytes: null, maxDepth: null } });
  assert.equal(unlimited.kind, 'terminated');
  assert.equal(run('return 0;', { limits: { maxMemoryBytes: 0 } }).kind, 'terminated');
  assert.equal(execute(program, { limits: { maxInstructions: 0 } }).kind, 'limit');
});

test('bad virtual projects and budgets return diagnostics instead of escaping exceptions', () => {
  for (const malformed of [null, {}, { entry: 'x.c', files: [] }, { entry: 'x.c', files: [{ name: 'y.c', source: '' }] }, { entry: 'x.c', files: [{ name: 'x.c', source: 5 }] }]) assert.equal(prepare(malformed).kind, 'prepare-error');
  for (const maxTokens of [-1, 1.5, Infinity, NaN, '1']) assert.equal(prepare(project('int main(void){}'), { limits: { maxTokens } }).diagnostics[0].code, 'INVALID_OPTIONS');
  assert.equal(prepare(project('int main(void){}'), { limits: { maxTokens: undefined } }).kind, 'prepared');
  assert.equal(prepare(project('int main(void){}'), { limits: { toString: 1 } }).diagnostics[0].code, 'INVALID_OPTIONS');
  assert.equal(prepare(project('int main(void){}'), { limits: { nonexistent: 1 } }).diagnostics[0].code, 'INVALID_OPTIONS');
  assert.equal(execute(prepared('int main(void){}'), { limits: { maxMemoryBytes: -1 } }).diagnostics[0].code, 'INVALID_OPTIONS');
});

test('preparation and execution timing and counters remain separate', () => {
  const prep = prepare(project('int main(void){return 1;}'));
  assert.equal(prep.kind, 'prepared');
  assert.ok(prep.metrics.prepareMs >= 0); assert.equal(prep.metrics.executeMs, 0);
  assert.equal(prep.metrics.instructionCount, 0); assert.equal(prep.metrics.peakMemoryBytes, 0);
  const execution = execute(prep.program);
  assert.equal(execution.kind, 'terminated');
  assert.equal(execution.metrics.prepareMs, 0); assert.ok(execution.metrics.executeMs >= 0);
  assert.equal(execution.metrics.tokenCount, prep.metrics.tokenCount);
  assert.equal(execution.metrics.sourceChars, prep.metrics.sourceChars);
  assert.ok(execution.metrics.instructionCount > 0);
});
