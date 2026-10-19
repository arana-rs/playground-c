import { failure } from '../internal.ts';
import type { Expression } from '../internal.ts';
import { functionType, hasVariableLengthObjectSize, isArray, isFunction, isInteger, isPointer, pointedToType, pointerTo, pointerType, sizeOfType, variableLengthArrayTypes } from '../type-system.ts';
import { unary } from '../numeric.ts';
import type { ExpressionHandler, ExpressionRuntimeContext } from './expression-runtime-context.ts';
import type { Frame } from './runtime-types.ts';

export function createSimpleExpressionHandler(context: ExpressionRuntimeContext): ExpressionHandler {
  const {
    ir, functions, functionIndices, functionSymbolIndices, memory,
    work, operands, localCell, globalReference, plain,
    integer, valueForType, truthValue, activePointerBases, activeUnknownPointerBases,
    pointerValueBases, unknownPointerValueBases, unionUnknownPointerBases, rememberIntegerPointerBases, propagateIntegerPointerOperation,
    mergeEffects, referenceEvaluation, materialize, evaluate, evaluateFullExpression,
    resolveVariableType, evaluateVariableBounds, stringReference
  } = context;
  return (node: Expression, frame: Frame, depth: number, used: boolean): boolean => {
    const at = node.location;
        if (node.kind === 'literal') operands.push(plain(node.value));
        else if (node.kind === 'string') operands.push(referenceEvaluation(stringReference(node), 'string'));
        else if (node.kind === 'variable') {
          const target = node.binding !== undefined
            ? localCell(frame, node.binding, at)
            : node.globalBinding !== undefined ? { binding: { id: node.globalBinding, name: node.name, type: node.type ?? 'int', location: at }, reference: globalReference(node.globalBinding, at) }
              : undefined;
          if (!target) failure('UNKNOWN_OBJECT', 'Unknown variable «' + node.name + '».', at);
          operands.push(referenceEvaluation(target.reference, node.name));
        } else if (node.kind === 'function') {
          const index = node.functionIndex ?? (node.symbolKey ? functionSymbolIndices.get(node.symbolKey) : undefined) ?? functionIndices.get(node.name);
          if (index === undefined || !functions[index]) failure('UNKNOWN_FUNCTION', 'Function «' + node.name + '».', at);
          const functionTypeValue = (node.type ? functionType(node.type) : undefined) ?? {
            kind: 'function' as const,
            returnType: functions[index].fn.returnType,
            parameters: functions[index].fn.parameters.map((parameter) => parameter.type),
          };
          operands.push(plain({ type: node.type && isPointer(node.type) ? node.type : pointerTo(functionTypeValue), value: { kind: 'function-pointer', functionIndex: index } }));
        } else if (node.kind === 'sizeof') {
          const type = node.valueType ?? node.operand?.type;
          if (!type) failure('INVALID_SIZEOF', 'Could not determine the type of the sizeof operand.', at);
          if (!hasVariableLengthObjectSize(type)) {
            operands.push(plain({ type: 'unsigned long', value: BigInt(sizeOfType(type, ir.aggregates, at)) }));
          } else if (node.valueType) {
            evaluateVariableBounds(variableLengthArrayTypes(type), frame, at, () => {
              const resolvedType = resolveVariableType(type, frame, at);
              operands.push(plain({ type: 'unsigned long', value: BigInt(sizeOfType(resolvedType, ir.aggregates, at)) }));
            }, false);
          } else {
            const operand = node.operand!;
            evaluateFullExpression(operand, frame, () => {
              const result = operands.pop();
              if (!result?.reference) failure('INVALID_SIZEOF', 'The variable-length sizeof operand has no runtime object.', at);
              operands.push(plain({ type: 'unsigned long', value: BigInt(sizeOfType(result.reference.type, ir.aggregates, at)) }));
            }, depth + 1, true);
          }
        } else if (node.kind === 'generic') {
          evaluate(node.selected, frame, depth + 1, used);
        } else if (node.kind === 'unary' && node.operator === '&') {
          if (node.operand.kind === 'index') {
            const subscript = node.operand;
            work.push(() => {
              const indexResult = operands.pop();
              const baseResult = operands.pop();
              if (!indexResult || !baseResult) failure('ENGINE_STACK_ERROR', 'Missing operand for &(array[index]).', at);
              const indexValue = materialize(indexResult, at);
              if (!isInteger(indexValue.type) || typeof indexValue.value !== 'bigint') failure('INVALID_INDEX', 'The array index must be an integer.', at);
              const baseValue = materialize(baseResult, at);
              if (!isPointer(baseValue.type)) failure('INVALID_INDEX', 'The subscript address requires a pointer.', at);
              const result = memory.pointerAdd(baseValue, indexValue.value, at);
              const effects = mergeEffects(baseResult, indexResult, at);
              result.type = node.type && isPointer(node.type) ? node.type : result.type;
              effects.value = result;
              effects.pointerBases = activePointerBases(baseResult.pointerBases);
              effects.unknownPointerBases = activeUnknownPointerBases(baseResult.unknownPointerBases);
              operands.push(effects);
            });
            evaluate(subscript.index, frame, depth + 1);
            evaluate(subscript.base, frame, depth + 1);
            return true;
          }
          if (node.operand.kind === 'unary' && node.operand.operator === '*') {
            const dereference = node.operand;
            work.push(() => {
              const operand = operands.pop();
              if (!operand) failure('ENGINE_STACK_ERROR', 'Missing operand for &*.', at);
              const pointer = materialize(operand, at);
              if (!isPointer(pointer.type)) failure('INVALID_OPERAND_TYPE', 'The * operator requires a pointer.', at);
              if (node.type && isPointer(node.type)) pointer.type = node.type;
              const result = plain(pointer);
              result.pointerBases = activePointerBases(operand.pointerBases);
              result.unknownPointerBases = activeUnknownPointerBases(operand.unknownPointerBases);
              operands.push(result);
            });
            evaluate(dereference.operand, frame, depth + 1);
            return true;
          }
          work.push(() => {
            const operand = operands.pop();
            if (!operand) failure('ENGINE_STACK_ERROR', 'Missing operand for &.', at);
            if (operand.reference) {
              const requestedPointer = node.type ? pointerType(node.type) : undefined;
              const result = plain(memory.addressOf(operand.reference, requestedPointer ?? pointerTo(operand.reference.type)));
              result.pointerBases = activePointerBases(operand.addressBases);
              result.unknownPointerBases = activeUnknownPointerBases(operand.unknownAddressBases);
              operands.push(result);
            } else {
              const value = materialize(operand, at);
              if (typeof value.value === 'object' && value.value !== null &&
                  (value.value as { kind?: string }).kind === 'function-pointer') {
                const result = plain(value);
                result.pointerBases = activePointerBases(operand.pointerBases);
                result.unknownPointerBases = activeUnknownPointerBases(operand.unknownPointerBases);
                operands.push(result);
              }
              else failure('INVALID_LVALUE', 'The & operator requires an object or function.', at);
            }
          });
          evaluate(node.operand, frame, depth + 1, true, true);
        } else if (node.kind === 'unary' && node.operator === '*') {
          work.push(() => {
            const operand = operands.pop();
            if (!operand) failure('ENGINE_STACK_ERROR', 'Missing operand for *.', at);
            const pointer = materialize(operand, at);
            if (!isPointer(pointer.type)) failure('INVALID_OPERAND_TYPE', 'The * operator requires a pointer.', at);
            if (isFunction(pointedToType(pointer.type) ?? 'void')) operands.push(plain(pointer));
            else operands.push(referenceEvaluation(
              memory.dereference(pointer, at), 'pointed object', operand, operand.pointerBases, operand.unknownPointerBases,
            ));
          });
          evaluate(node.operand, frame, depth + 1);
        } else if (node.kind === 'unary') {
          work.push(() => {
            const result = operands.pop();
            if (!result) failure('ENGINE_STACK_ERROR', 'Missing unary operand.', at);
            const value = materialize(result, at);
            result.value = node.operator === '!' ? integer(!truthValue(value)) : unary(node.operator, value, at);
            propagateIntegerPointerOperation(node.operator, value, undefined, result.value);
            if (isInteger(result.value.type) && isPointer(value.type)) {
              rememberIntegerPointerBases(result.value, [], unionUnknownPointerBases(result.pointerBases, result.unknownPointerBases));
            }
            operands.push(result);
          });
          evaluate(node.operand, frame, depth + 1);
        } else if (node.kind === 'cast') {
          evaluateVariableBounds(variableLengthArrayTypes(node.targetType), frame, at, () => {
            const targetType = resolveVariableType(node.targetType, frame, at);
            work.push(() => {
              const result = operands.pop();
              if (!result) failure('ENGINE_STACK_ERROR', 'Missing cast operand.', at);
              const sourceValue = materialize(result, at);
              result.value = valueForType(sourceValue, targetType, at);
              if (isPointer(targetType)) {
                if (isPointer(sourceValue.type)) {
                  result.pointerBases = activePointerBases(result.pointerBases);
                  result.unknownPointerBases = activeUnknownPointerBases(result.unknownPointerBases);
                } else if (typeof result.value.value === 'object' && result.value.value !== null && result.value.value.kind === 'object-pointer') {
                  result.pointerBases = activePointerBases(pointerValueBases.get(result.value.value));
                  result.unknownPointerBases = activeUnknownPointerBases(unknownPointerValueBases.get(result.value.value));
                }
              } else {
                result.pointerBases = undefined;
                result.unknownPointerBases = undefined;
              }
              result.reference = undefined;
              operands.push(result);
            });
            // An explicit cast to void discards the operand's value. In particular,
            // a non-void function may fall through when its result is discarded.
            evaluate(node.operand, frame, depth + 1, targetType !== 'void');
          }, false);
        } else if (node.kind === 'decay') {
          work.push(() => {
            const result = operands.pop();
            if (!result) failure('ENGINE_STACK_ERROR', 'Missing operand for array conversion.', at);
            if (result.reference && isArray(result.reference.type)) {
              result.value = memory.decay(result.reference);
              result.pointerBases = activePointerBases(result.addressBases);
              result.unknownPointerBases = activeUnknownPointerBases(result.unknownAddressBases);
              result.reference = undefined;
            } else result.value = materialize(result, at);
            operands.push(result);
          });
          evaluate(node.operand, frame, depth + 1, true, true);

        }
        else return false;
        return true;
  };
}
