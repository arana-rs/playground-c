import { failure } from './internal.ts';
import { selectGenericAssociation } from './parser-constant-expressions.ts';
import type {
  AnalyzeInitializer, ExpressionOperations, FunctionAnalysisContext, SpecialExpression,
} from './parser-analysis-context.ts';
import { analyzeCallExpression } from './parser-analysis-call.ts';
import {
  decayType, isAggregate, isArray, isComplete, isFunction, isPointer, isScalar, pointedToType, unqualifiedType,
} from './type-system.ts';

export function analyzeSpecialExpression(
  context: FunctionAnalysisContext,
  node: SpecialExpression,
  operations: ExpressionOperations,
  analyzeInitializer: AnalyzeInitializer,
): void {
  const { aggregates } = context.environment;
  switch (node.kind) {
    case 'decay': {
      const source = node.operand.type!;
      if (!isArray(source) && !isFunction(source)) failure('TYPE_ERROR', 'Invalid array/function decay conversion.', node.location);
      node.type = decayType(source);
      break;
    }
    case 'compoundLiteral': {
      if (isFunction(node.objectType) || node.objectType === 'void' || !isComplete(node.objectType, aggregates)) {
        failure('INCOMPLETE_TYPE', 'A compound literal requires a complete object type.', node.location);
      }
      node.initializer = analyzeInitializer(node.objectType, node.initializer, false);
      node.type = node.objectType;
      break;
    }
    case 'vaArg': {
      node.ap = operations.analyzedValue(node.ap);
      if (!isPointer(node.ap.type!) || unqualifiedType(pointedToType(node.ap.type!)!) !== 'void') {
        failure('TYPE_ERROR', 'va_arg requires an active va_list.', node.location);
      }
      if (!isScalar(node.valueType) && !isAggregate(node.valueType) || !isComplete(node.valueType, aggregates)) {
        failure('TYPE_ERROR', 'The va_arg type must be a complete object type.', node.location);
      }
      node.type = node.valueType;
      break;
    }
    case 'call':
      analyzeCallExpression(context, node, operations.analyzedValue, operations.canAssign);
      break;
    case 'generic': {
      node.control = operations.analyzedValue(node.control);
      const selected = selectGenericAssociation(node.control.type!, node.associations, aggregates, node.location);
      node.selected = selected;
      node.type = selected.type!;
      node.isConst = selected.isConst;
      node.register = selected.register;
      node.bitField = selected.bitField;
      break;
    }
  }
}
