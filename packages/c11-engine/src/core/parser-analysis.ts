import type { FunctionIR, GlobalObject, ParsedProgram, Statement } from './internal.ts';
import { failure } from './internal.ts';
import { BUILTINS } from './numeric.ts';
import { LIBRARY_FUNCTIONS } from './headers.ts';
import { analyzeFunction } from './parser-analysis-function.ts';
import type { AnalysisEnvironment, AnalysisOptions, FunctionSignature } from './parser-analysis-context.ts';
import { comesBefore } from './parser-analysis-order.ts';
import { compatibleType, functionOf, pointerType, sameType, unqualifiedType } from './type-system.ts';

export function analyze(program: ParsedProgram, options: AnalysisOptions = {}): number | undefined {
  const { functions, globals, aggregates } = program;
  const signatures = new Map<string, FunctionSignature>();
  const globalByName = new Map<string, GlobalObject>();
  for (const global of globals) {
    const prior = globalByName.get(global.name);
    if (prior) {
      if (!compatibleType(prior.type, global.type)) {
        failure('CONFLICTING_TYPES', `Incompatible declarations of «${global.name}».`, global.location);
      }
      if (prior.initializer && global.initializer) {
        failure('REDEFINITION', `Global object «${global.name}» is already initialized.`, global.location);
      }
      if (!prior.initializer && global.initializer) prior.initializer = global.initializer;
      continue;
    }
    globalByName.set(global.name, global);
  }
  const functionIRType = (fn: FunctionIR) =>
    functionOf(fn.returnType, fn.parameters.map(parameter => parameter.type), !!fn.variadic, fn.prototype !== false);
  for (let index = 0; index < functions.length; index++) {
    const fn = functions[index];
    if (globalByName.has(fn.name)) {
      failure('CONFLICTING_TYPES', `«${fn.name}» is declared as both an object and a function.`, fn.location);
    }
    const prior = signatures.get(fn.name);
    if (prior && !compatibleType(functionIRType(prior.fn), functionIRType(fn))) {
      failure('CONFLICTING_TYPES', `Incompatible declarations of «${fn.name}».`, fn.location);
    }
    if (fn.body && prior?.definition !== undefined) {
      failure('REDEFINITION', `Function «${fn.name}» already has a definition.`, fn.location);
    }
    const signature = prior ?? { fn };
    if (fn.body) signature.definition = index;
    const builtin = BUILTINS[fn.name] || LIBRARY_FUNCTIONS.includes(fn.name) || fn.name.startsWith('__builtin_va_')
      ? { returnType: fn.returnType, parameters: fn.parameters.map(parameter => parameter.type) }
      : undefined;
    if (!fn.body && builtin) {
      if (!LIBRARY_FUNCTIONS.includes(fn.name) && !fn.name.startsWith('__builtin_va_') &&
          (!sameType(fn.returnType, builtin.returnType) || fn.parameters.length !== builtin.parameters.length ||
            !fn.parameters.every((parameter, parameterIndex) => sameType(parameter.type, builtin.parameters[parameterIndex])))) {
        failure('CONFLICTING_TYPES', `Prototype for «${fn.name}» does not match its library declaration.`, fn.location);
      }
      signature.builtin = index;
    }
    if (signature.fn.prototype === false && fn.prototype !== false) signature.fn = fn;
    signatures.set(fn.name, signature);
  }
  for (const signature of signatures.values()) {
    if (signature.definition === undefined && signature.builtin !== undefined) {
      functions[signature.builtin].builtin = true;
    }
  }

  const main = signatures.get('main');
  if (!options.allowMissingMain) {
    if (!main || main.definition === undefined) {
      failure(
        'MISSING_MAIN',
        'A definition of main with external linkage is required.',
        functions[0]?.location ?? globals[0]?.location ?? { file: program.translationUnit ?? 'main.c', line: 1, column: 1 },
      );
    }
    const argv = main.fn.parameters[1]?.type;
    const argvPointer = argv ? pointerType(argv) : undefined;
    const argvElementPointer = argvPointer ? pointerType(argvPointer.base) : undefined;
    if (unqualifiedType(main.fn.returnType) !== 'int' || main.fn.parameters.length &&
        !(main.fn.parameters.length === 2 && unqualifiedType(main.fn.parameters[0].type) === 'int' && argvPointer &&
          argvElementPointer && unqualifiedType(argvElementPointer.base) === 'char')) {
      failure('UNSUPPORTED_FEATURE', 'P4 supports int main(void) or int main(int, char **).', main.fn.location);
    }
  }
  const mainDefinition = main?.definition;
  const environment: AnalysisEnvironment = {
    program,
    functions,
    globals,
    aggregates,
    options,
    signatures,
    globalByName,
    visibleFunctions: new Map(),
    functionIRType,
    globalsAnalyzed: false,
  };

  for (const fn of functions) {
    const signature = signatures.get(fn.name)!;
    environment.visibleFunctions.set(fn.name, signature);
    if (!hasBody(fn)) continue;
    const globalVisible = new Map<string, GlobalObject>();
    for (const global of globals) {
      if (comesBefore(global.location, fn.location)) globalVisible.set(global.name, globalByName.get(global.name)!);
    }
    analyzeFunction(environment, fn, globalVisible);
  }
  return mainDefinition;
}

function hasBody(fn: FunctionIR): fn is FunctionIR & { body: Extract<Statement, { kind: 'block' }> } {
  return fn.body !== undefined;
}
