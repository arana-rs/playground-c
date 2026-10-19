import type { ArrayCType, CType, Expression, Location } from './internal.ts';
import { failure } from './internal.ts';
import { aggregateMemberPath, expressionChildren, isNullPointerConstant, requireInteger } from './parser-constant-expressions.ts';
import type {
  AnalyzeInitializer, ExpressionOperations, FunctionAnalysisContext, OperatorExpression, SpecialExpression,
} from './parser-analysis-context.ts';
import { analyzeOperatorExpression } from './parser-analysis-expression-operators.ts';
import { analyzeSpecialExpression } from './parser-analysis-expression-special.ts';
import type { OperatorExpressionOperations } from './parser-analysis-expression-operators.ts';
import { vaIntrinsics } from './parser-analysis-call.ts';
import { canConvertPointerType, compatibleType, arrayOf, decayType, functionOf, isAggregate, isArithmetic, isArray, isFunction, isInteger, isPointer, pointedToType, pointerTo, unqualifiedType } from './type-system.ts';

export function createExpressionOperations(
  context: FunctionAnalysisContext,
  analyzeInitializer: AnalyzeInitializer,
): ExpressionOperations {
  const { aggregates, options, visibleFunctions, functionIRType } = context.environment;
  const { globalVisible } = context;
  const findLocal = context.findLocal;
  const findMemberPath = (type: CType, name: string, at: Expression['location']) =>
    aggregateMemberPath(type, name, aggregates, at);
  const analyzedVlaBounds = new WeakSet<object>();

  const isLvalue = (node: Expression): boolean => {
    switch (node.kind) {
      case 'variable': case 'index': return true;
      case 'member': return node.type !== undefined && !isFunction(node.type) && (node.arrow || isLvalue(node.base));
      case 'unary': return node.operator === '*';
      case 'compoundLiteral': return true;
      case 'generic': return isLvalue(node.selected);
      default: return false;
    }
  };

  const canAssign = (target: CType, source: CType, expression: Expression): boolean => {
    if (isArithmetic(target) && isArithmetic(source)) return true;
    if (isAggregate(target) || isAggregate(source)) return compatibleType(target, source);
    if (isPointer(target)) {
      if (isPointer(source)) return compatibleType(target, source) || canConvertPointerType(source, target);
      return isInteger(source) && isNullPointerConstant(expression, aggregates);
    }
    return false;
  };

  const analyzedValue = (node: Expression): Expression => {
    const source = node.type!;
    if (isArray(source) || isFunction(source)) {
      if (isArray(source) && node.register) {
        failure('INVALID_LVALUE', 'Cannot convert an array belonging to a register object to a pointer.', node.location);
      }
      return { kind: 'decay', operand: node, location: node.location, type: decayType(source) };
    }
    // C's lvalue conversion removes only the top-level qualifiers. Pointee
    // qualifiers remain nested in the pointer type.
    node.type = unqualifiedType(source);
    return node;
  };

  function analyzeVariableLengthBounds(bounds: readonly ArrayCType[], at: Location): void {
    for (const array of bounds) {
      const expression = array.lengthExpression;
      if (!expression || analyzedVlaBounds.has(expression)) continue;
      const type = analyzeExpression(expression);
      requireInteger(type, expression.location ?? at);
      analyzedVlaBounds.add(expression);
    }
  }

  function analyzeExpression(root: Expression): CType {
    const pending: { node: Expression; done: boolean }[] = [{ node: root, done: false }];
    while (pending.length) {
      const work = pending.pop()!;
      const node = work.node;
      if (!work.done) {
        pending.push({ node, done: true });
        const children = expressionChildren(node);
        for (let index = children.length - 1; index >= 0; index--) pending.push({ node: children[index], done: false });
        continue;
      }
      switch (node.kind) {
        case 'literal': node.type = node.value.type; break;
        case 'string': node.type = arrayOf('char', node.bytes.length); break;
        case 'variable': {
          if (vaIntrinsics.has(node.name)) {
            const replacement = node as unknown as Extract<Expression, { kind: 'function' }>;
            replacement.kind = 'function'; replacement.name = node.name;
            replacement.type = functionOf('void', [], true);
            break;
          }
          const local = findLocal(node.name);
          if (local) {
            if (local.globalBinding !== undefined) node.globalBinding = local.globalBinding;
            else node.binding = local.id;
            node.type = local.type; node.isConst = !!local.isConst; node.register = !!local.register; break;
          }
          const global = globalVisible.get(node.name);
          if (global) { node.globalBinding = global.id; node.type = global.type; node.isConst = !!global.isConst; break; }
          const signature = visibleFunctions.get(node.name);
          if (signature) {
            const functionIndex = signature.definition ?? signature.builtin;
            if (functionIndex === undefined && !options.allowUnresolved) {
              failure('UNDEFINED_FUNCTION', `Function «${node.name}» has no definition in this program.`, node.location);
            }
            const replacement = node as unknown as Extract<Expression, { kind: 'function' }>;
            replacement.kind = 'function'; replacement.functionIndex = functionIndex;
            replacement.symbolKey = signature.fn.symbolKey; replacement.type = functionIRType(signature.fn); break;
          }
          failure('UNKNOWN_IDENTIFIER', `Variable «${node.name}» is not declared in this scope.`, node.location);
        }
        case 'function': {
          const signature = visibleFunctions.get(node.name);
          if (!signature) failure('UNKNOWN_FUNCTION', `Function «${node.name}» must be declared before use.`, node.location);
          const functionIndex = signature.definition ?? signature.builtin;
          if (functionIndex === undefined && !options.allowUnresolved) {
            failure('UNDEFINED_FUNCTION', `Function «${node.name}» has no definition in this program.`, node.location);
          }
          node.functionIndex = functionIndex; node.symbolKey = signature.fn.symbolKey; node.type = functionIRType(signature.fn); break;
        }
        case 'unary': case 'binary': case 'assignment': case 'update': case 'cast': case 'sizeof':
        case 'conditional': case 'index': case 'member': {
          const operatorOperations: OperatorExpressionOperations = {
            analyzedValue,
            analyzeVariableLengthBounds,
            isLvalue,
            canAssign,
            findMemberPath,
          };
          analyzeOperatorExpression(context, node as OperatorExpression, operatorOperations);
          break;
        }
        case 'decay': case 'compoundLiteral': case 'vaArg': case 'call': case 'generic': {
          const operations: ExpressionOperations = {
            analyzeExpression,
            analyzedValue,
            convertedValue,
            canAssign,
            analyzeVariableLengthBounds,
          };
          analyzeSpecialExpression(context, node as SpecialExpression, operations, analyzeInitializer);
          break;
        }
      }
    }
    return root.type!;
  }

  const convertedValue = (node: Expression): Expression => {
    const source = analyzeExpression(node);
    if (isArray(source) || isFunction(source)) {
      const decay = decayType(source);
      const converted: Expression = {
        kind: 'decay', operand: node, location: node.location,
        type: isArray(source) && node.isConst && isPointer(decay) ? pointerTo(pointedToType(decay)!, { baseConst: true }) : decay,
      };
      return converted;
    }
    return node;
  };

  return { analyzeExpression, analyzedValue, convertedValue, canAssign, analyzeVariableLengthBounds };
}
