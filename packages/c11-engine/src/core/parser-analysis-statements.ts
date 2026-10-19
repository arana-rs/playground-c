import type { Binding, CType, Location, Statement, VariablyModifiedIdentifier } from './internal.ts';
import { failure } from './internal.ts';
import { constantExpression, requireInteger, requireIntegerConstantExpression, requireScalar } from './parser-constant-expressions.ts';
import type { AnalyzeInitializer, ExpressionOperations, FunctionAnalysisContext } from './parser-analysis-context.ts';
import { convert, promote, truth } from './numeric.ts';
import {
  compatibleType, hasVariableLengthBound, hasVariableLengthObjectSize, qualifiersOf,
  typeName, variableLengthArrayTypes,
} from './type-system.ts';

export function analyzeStatements(
  context: FunctionAnalysisContext,
  operations: ExpressionOperations,
  analyzeInitializer: AnalyzeInitializer,
): void {
  const { fn, scopes } = context;
  const { globals, aggregates } = context.environment;
  const {
    analyzeExpression, analyzeVariableLengthBounds, canAssign, convertedValue,
  } = operations;
  const { declare, markVariablyModifiedIdentifier, snapshotVariablyModifiedIdentifiers,
    entersVariablyModifiedScope, pushScope, popScope } = context;
    type SwitchContext = {
      type: CType;
      cases: Set<string>;
      hasDefault: boolean;
      variablyModifiedIdentifiers: ReadonlySet<VariablyModifiedIdentifier>;
    };
    const labels = new Map<string, { location: Location; variablyModifiedIdentifiers: ReadonlySet<VariablyModifiedIdentifier> }>();
    const gotos: { node: Extract<Statement, { kind: 'goto' }>; variablyModifiedIdentifiers: ReadonlySet<VariablyModifiedIdentifier> }[] = [];
    type StatementWork =
      | { node: Statement; loops: number; switches: SwitchContext[]; root?: boolean }
      | { leaveScope: true }
      | { finishFor: Extract<Statement, { kind: 'for' }> };
    const pendingStatements: StatementWork[] = [{ node: fn.body, loops: 0, switches: [], root: true }];
    while (pendingStatements.length) {
      const work = pendingStatements.pop()!;
      if ('leaveScope' in work) { popScope(); continue; }
      if ('finishFor' in work) {
        const node = work.finishFor;
        if (node.condition) { node.condition = convertedValue(node.condition); requireScalar(node.condition.type!, node.condition.location); }
        if (node.increment) analyzeExpression(node.increment);
        continue;
      }
      const { node, loops, switches } = work;
      switch (node.kind) {
        case 'block':
          if (!work.root) { pushScope(node); pendingStatements.push({ leaveScope: true }); }
          for (let index = node.statements.length - 1; index >= 0; index--) pendingStatements.push({ node: node.statements[index], loops, switches });
          break;
        case 'sequence':
          for (let index = node.statements.length - 1; index >= 0; index--) pendingStatements.push({ node: node.statements[index], loops, switches });
          break;
        case 'typeDeclaration':
          analyzeVariableLengthBounds(variableLengthArrayTypes(node.type), node.location);
          if (hasVariableLengthBound(node.type)) {
            markVariablyModifiedIdentifier(variableLengthArrayTypes(node.type));
          }
          break;
        case 'declaration': {
          analyzeVariableLengthBounds(variableLengthArrayTypes(node.type), node.location);
          if (node.extern) {
            const globalIndex = globals.findIndex((global) => global.symbolKey === node.symbolKey);
            if (globalIndex < 0) failure('ENGINE_INTERNAL_ERROR', `No global extern symbol exists for «${node.name}».`, node.location);
            const global = globals[globalIndex];
            if (!compatibleType(global.type, node.type) || !!global.threadLocal !== !!node.threadLocal) {
            failure('CONFLICTING_TYPES', `Incompatible declarations of object «${node.name}».`, node.location);
            }
            if (scopes[scopes.length - 1].names.has(node.name)) failure('REDECLARATION', `Variable «${node.name}» is already declared in this scope.`, node.location);
            const binding: Binding = {
              id: -1, name: node.name, type: node.type, location: node.location,
              isConst: !!node.const, qualifiers: qualifiersOf(node.type), linkage: global.linkage ?? 'external', symbolKey: node.symbolKey,
              globalBinding: globalIndex, storageDuration: node.threadLocal ? 'thread-local' : 'static',
              threadLocal: !!node.threadLocal, alignment: node.alignment, requestedAlignment: node.requestedAlignment,
            };
            scopes[scopes.length - 1].names.set(node.name, binding);
          } else {
            node.binding = declare(node.name, node.type, node.location, false, !!node.const, !!node.static);
            const binding = fn.bindings[node.binding];
            binding.register = !!node.register;
            binding.alignment = node.alignment;
            binding.requestedAlignment = node.requestedAlignment;
            binding.threadLocal = !!node.threadLocal;
            if (node.threadLocal) binding.storageDuration = 'thread-local';
          }
          if (hasVariableLengthBound(node.type)) {
            markVariablyModifiedIdentifier(
              variableLengthArrayTypes(node.type),
              hasVariableLengthObjectSize(node.type) ? node.binding : undefined,
            );
          }
          if (node.initializer) node.initializer = analyzeInitializer(node.type, node.initializer, !!node.static);
          break;
        }
        case 'staticAssert': {
          requireInteger(analyzeExpression(node.condition), node.location);
          requireIntegerConstantExpression(node.condition, '_Static_assert', aggregates);
          const value = constantExpression(node.condition, aggregates);
          if (!truth(value)) failure('STATIC_ASSERT_FAILED', node.message || '_Static_assert expression is false.', node.location);
          break;
        }
        case 'return': {
          if (fn.returnType === 'void') {
            if (node.value) failure('TYPE_ERROR', 'A void function cannot return an expression.', node.location);
          } else {
            if (!node.value) failure('SYNTAX_ERROR', 'A non-void function requires a return value.', node.location);
            node.value = convertedValue(node.value);
            if (!canAssign(fn.returnType, node.value.type!, node.value)) failure('TYPE_ERROR', `Cannot return ${typeName(node.value.type!, aggregates)} from a function returning ${typeName(fn.returnType, aggregates)}.`, node.location);
          }
          break;
        }
        case 'expression': analyzeExpression(node.value); break;
        case 'if':
          node.condition = convertedValue(node.condition); requireScalar(node.condition.type!, node.condition.location);
          pushScope(); pendingStatements.push({ leaveScope: true });
          if (node.else) pendingStatements.push({ node: node.else, loops, switches });
          pendingStatements.push({ node: node.then, loops, switches });
          break;
        case 'while': case 'do':
          node.condition = convertedValue(node.condition); requireScalar(node.condition.type!, node.condition.location);
          pushScope(); pendingStatements.push({ leaveScope: true });
          pendingStatements.push({ node: node.body, loops: loops + 1, switches });
          break;
        case 'for': {
          pushScope(node); pendingStatements.push({ leaveScope: true });
          pendingStatements.push({ node: node.body, loops: loops + 1, switches });
          pendingStatements.push({ finishFor: node });
          if (node.initializer) pendingStatements.push({ node: node.initializer, loops, switches });
          break;
        }
        case 'switch': {
          const valueType = analyzeExpression(node.value); requireInteger(valueType, node.value.location);
          const context: SwitchContext = {
            type: promote(valueType), cases: new Set(), hasDefault: false,
            variablyModifiedIdentifiers: snapshotVariablyModifiedIdentifiers(),
          };
          pushScope(); pendingStatements.push({ leaveScope: true });
          pendingStatements.push({ node: node.body, loops, switches: [...switches, context] });
          break;
        }
        case 'case': {
          const context = switches[switches.length - 1];
          if (!context) failure('INVALID_CASE', 'case and default require an enclosing switch.', node.location);
          if (entersVariablyModifiedScope(snapshotVariablyModifiedIdentifiers(), context.variablyModifiedIdentifiers)) {
            failure('TYPE_ERROR', 'A switch statement cannot jump to a case or default label within the scope of an identifier with a variably modified type.', node.location);
          }
          if (node.value) {
            requireInteger(analyzeExpression(node.value), node.value.location);
            requireIntegerConstantExpression(node.value, 'case', aggregates);
            const constant = convert(constantExpression(node.value, aggregates), context.type, node.location);
            const key = String(constant.value);
            if (context.cases.has(key)) failure('DUPLICATE_CASE', 'The switch contains two case labels with the same value.', node.location);
            context.cases.add(key); node.constant = constant;
          } else {
            if (context.hasDefault) failure('DUPLICATE_DEFAULT', 'The switch contains more than one default.', node.location);
            context.hasDefault = true;
          }
          pendingStatements.push({ node: node.statement, loops, switches });
          break;
        }
        case 'label':
          if (labels.has(node.name)) failure('DUPLICATE_LABEL', `Label «${node.name}» already exists in this function.`, node.location);
          labels.set(node.name, { location: node.location, variablyModifiedIdentifiers: snapshotVariablyModifiedIdentifiers() });
          pendingStatements.push({ node: node.statement, loops, switches });
          break;
        case 'goto': gotos.push({ node, variablyModifiedIdentifiers: snapshotVariablyModifiedIdentifiers() }); break;
        case 'break': if (!loops && !switches.length) failure('INVALID_BREAK', 'break requires an enclosing loop or switch.', node.location); break;
        case 'continue': if (!loops) failure('INVALID_CONTINUE', 'continue requires an enclosing loop.', node.location); break;
        case 'empty': break;
      }
    }
    for (const jump of gotos) {
      const target = labels.get(jump.node.target);
      if (!target) failure('UNKNOWN_LABEL', `Label «${jump.node.target}» does not exist in this function.`, jump.node.location);
      if (entersVariablyModifiedScope(target.variablyModifiedIdentifiers, jump.variablyModifiedIdentifiers)) {
        failure('TYPE_ERROR', 'A goto statement cannot jump into the scope of an identifier with a variably modified type.', jump.node.location);
      }
      jump.node.vmScopeExit = [...jump.variablyModifiedIdentifiers]
        .filter((identifier) => !target.variablyModifiedIdentifiers.has(identifier));
      jump.node.vmScopeTarget = [...target.variablyModifiedIdentifiers];
    }
}
