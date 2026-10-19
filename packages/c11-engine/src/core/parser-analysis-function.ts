import type { ArrayCType, Binding, CType, FunctionIR, GlobalObject, Location, VariablyModifiedIdentifier } from './internal.ts';
import { failure } from './internal.ts';
import { constantExpression, requireInteger, requireIntegerConstantExpression } from './parser-constant-expressions.ts';
import type { AnalysisEnvironment, ExpressionOperations, FunctionAnalysisContext } from './parser-analysis-context.ts';
import { analyzeInitializerWithContext } from './parser-analysis-initializers.ts';
import { analyzeStatements } from './parser-analysis-statements.ts';
import { comesBefore } from './parser-analysis-order.ts';
import { createExpressionOperations } from './parser-analysis-expressions.ts';
import { truth } from './numeric.ts';
import { hasVariableLengthBound, qualifiersOf, variableLengthArrayTypes } from './type-system.ts';
import type { Scope } from './parser-context-types.ts';

export function analyzeFunction(
  environment: AnalysisEnvironment,
  fn: FunctionIR & { body: Extract<import('./internal.ts').Statement, { kind: 'block' }> },
  globalVisible: Map<string, GlobalObject>,
): void {
  const { program, globals, aggregates, globalByName, signatures, functions, visibleFunctions } = environment;
  const scopes: Scope[] = [{ names: new Map(), variablyModifiedIdentifiers: [], owner: fn.body }];
  const activeVariablyModifiedIdentifiers = new Set<VariablyModifiedIdentifier>();
  fn.body.bindings = [];
  fn.bindings = [];

  const findLocal = (name: string): Binding | undefined => {
    for (let index = scopes.length - 1; index >= 0; index--) {
      const binding = scopes[index].names.get(name);
      if (binding) return binding;
    }
    return undefined;
  };
  const declare = (
    name: string,
    type: CType,
    location: Location,
    parameter = false,
    isConst = false,
    staticStorage = false,
  ): number => {
    const scope = scopes[scopes.length - 1];
    if (scope.names.has(name)) failure('REDECLARATION', `Variable «${name}» is already declared in this scope.`, location);
    const id = fn.bindings.length;
    const binding: Binding = {
      id, name, type, location, isConst: isConst || !!qualifiersOf(type).const,
      qualifiers: qualifiersOf(type),
      ...(parameter ? { isParameter: true } : {}),
      storageDuration: staticStorage ? 'static' : 'automatic',
      ...(staticStorage ? { storageKey: `${fn.translationUnit ?? program.translationUnit ?? location.file}::${fn.symbolKey ?? fn.name}::${name}::${id}` } : {}),
    };
    fn.bindings.push(binding);
    scope.names.set(name, binding);
    if (!parameter) scope.owner?.bindings?.push(binding.id);
    return binding.id;
  };
  const markVariablyModifiedIdentifier = (arrayTypes: readonly ArrayCType[], vlaBinding?: number): void => {
    const identifier: VariablyModifiedIdentifier = {
      arrayTypes,
      ...(vlaBinding === undefined ? {} : { vlaBinding }),
    };
    scopes[scopes.length - 1].variablyModifiedIdentifiers.push(identifier);
    activeVariablyModifiedIdentifiers.add(identifier);
  };
  const snapshotVariablyModifiedIdentifiers = (): ReadonlySet<VariablyModifiedIdentifier> =>
    new Set(activeVariablyModifiedIdentifiers);
  const entersVariablyModifiedScope = (
    target: ReadonlySet<VariablyModifiedIdentifier>,
    source: ReadonlySet<VariablyModifiedIdentifier>,
  ): boolean => {
    for (const identifier of target) if (!source.has(identifier)) return true;
    return false;
  };
  const pushScope = (owner?: Scope['owner']): void => {
    if (owner) owner.bindings = [];
    scopes.push({ names: new Map(), variablyModifiedIdentifiers: [], owner });
  };
  const popScope = (): void => {
    if (scopes.length <= 1) return;
    const scope = scopes.pop()!;
    for (const identifier of scope.variablyModifiedIdentifiers) activeVariablyModifiedIdentifiers.delete(identifier);
  };

  const context: FunctionAnalysisContext = {
    environment,
    fn,
    globalVisible,
    scopes,
    activeVariablyModifiedIdentifiers,
    findLocal,
    declare,
    markVariablyModifiedIdentifier,
    snapshotVariablyModifiedIdentifiers,
    entersVariablyModifiedScope,
    pushScope,
    popScope,
  };
  let expressions: ExpressionOperations;
  const analyzeInitializer = (type: CType, initializer: import('./internal.ts').Initializer, fileDuration: boolean) =>
    analyzeInitializerWithContext(context, expressions, type, initializer, fileDuration);
  expressions = createExpressionOperations(context, analyzeInitializer);

  if (!environment.globalsAnalyzed) {
    environment.globalsAnalyzed = true;
    for (const assertion of program.staticAssertions ?? []) {
      requireInteger(expressions.analyzeExpression(assertion.condition), assertion.location);
      requireIntegerConstantExpression(assertion.condition, '_Static_assert', aggregates);
      const value = constantExpression(assertion.condition, aggregates);
      if (!truth(value)) failure('STATIC_ASSERT_FAILED', assertion.message || '_Static_assert expression is false.', assertion.location);
    }
    const priorVisible = new Map(globalVisible);
    const priorFunctions = new Map(visibleFunctions);
    for (const global of globals) {
      if (!global.initializer) continue;
      globalVisible.clear();
      for (const candidate of globals) {
        if (comesBefore(candidate.location, global.initializer.location)) {
          globalVisible.set(candidate.name, globalByName.get(candidate.name)!);
        }
      }
      visibleFunctions.clear();
      for (const declaration of functions) {
        if (comesBefore(declaration.location, global.initializer.location)) {
          visibleFunctions.set(declaration.name, signatures.get(declaration.name)!);
        }
      }
      global.initializer = analyzeInitializer(global.type, global.initializer, true);
    }
    globalVisible.clear();
    for (const [name, global] of priorVisible) globalVisible.set(name, global);
    visibleFunctions.clear();
    for (const [name, declaration] of priorFunctions) visibleFunctions.set(name, declaration);
  }

  for (const parameter of fn.parameters) {
    if (!parameter.name) failure('SYNTAX_ERROR', 'Parameters in a definition must have names.', parameter.location);
    parameter.binding = declare(parameter.name, parameter.type, parameter.location, true, parameter.isConst);
    fn.bindings[parameter.binding].register = !!parameter.register;
    if (hasVariableLengthBound(parameter.type)) {
      markVariablyModifiedIdentifier(variableLengthArrayTypes(parameter.type));
    }
  }
  for (const parameter of fn.parameters) {
    expressions.analyzeVariableLengthBounds(parameter.variableLengthBounds ?? [], parameter.location);
  }
  analyzeStatements(context, expressions, analyzeInitializer);
}
