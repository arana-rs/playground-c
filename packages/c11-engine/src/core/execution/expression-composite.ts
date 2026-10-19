import { failure } from '../internal.ts';
import type { Expression, ObjectReference } from '../internal.ts';
import { isAggregate, isArray, isInteger, isPointer, qualifiersOf } from '../type-system.ts';
import type { ExpressionHandler, ExpressionRuntimeContext } from './expression-runtime-context.ts';
import type { Frame } from './runtime-types.ts';

export function createCompositeExpressionHandler(context: ExpressionRuntimeContext): ExpressionHandler {
  const {
    ir, memory, work, operands, initializedStaticExpressions,
    plain, integer, valueForType, truthValue, activePointerBases,
    activeUnknownPointerBases, unionPointerBases, unionUnknownPointerBases, rememberIntegerPointerBases, propagateIntegerPointerOperation,
    integerPointerOrigins, mergeEffects, referenceEvaluation, materialize, evaluate,
    initializeObject, aggregateDefinition, operateBinary, allocateDebugObject, debugTypeSummary
  } = context;
  return (node: Expression, frame: Frame, depth: number, used: boolean): boolean => {
    const at = node.location;
        if (node.kind === 'index') {
          work.push(() => {
            const indexResult = operands.pop();
            const baseResult = operands.pop();
            if (!indexResult || !baseResult) failure('ENGINE_STACK_ERROR', 'Missing indexing operand.', at);
            const indexValue = materialize(indexResult, at);
            if (!isInteger(indexValue.type) || typeof indexValue.value !== 'bigint') {
              failure('INVALID_INDEX', 'The array index must be an integer.', at);
            }
            let reference: ObjectReference;
            if (baseResult.reference && isArray(baseResult.reference.type)) {
              reference = memory.element(baseResult.reference, indexValue.value, at);
            } else {
              const base = materialize(baseResult, at);
              if (!isPointer(base.type)) failure('INVALID_INDEX', 'Indexing requires an array or pointer.', at);
              reference = memory.dereference(memory.pointerAdd(base, indexValue.value, at), at);
            }
            const effects = mergeEffects(baseResult, indexResult, at);
            const addressBases = baseResult.reference && isArray(baseResult.reference.type)
              ? baseResult.addressBases : baseResult.pointerBases;
              const unknownAddressBases = baseResult.reference && isArray(baseResult.reference.type)
                ? baseResult.unknownAddressBases : baseResult.unknownPointerBases;
              operands.push(referenceEvaluation(reference, 'element', effects, addressBases, unknownAddressBases));
          });
          evaluate(node.index, frame, depth + 1);
          evaluate(node.base, frame, depth + 1, true, true);
        } else if (node.kind === 'member') {
          work.push(() => {
            const baseResult = operands.pop();
            if (!baseResult) failure('ENGINE_STACK_ERROR', 'Missing member object.', at);
            let baseReference: ObjectReference;
            let effects = baseResult;
            let addressBases: Iterable<number> | undefined;
            let unknownAddressBases: Iterable<number> | undefined;
            if (node.arrow) {
              const pointer = materialize(baseResult, at);
              baseReference = memory.dereference(pointer, at);
              addressBases = baseResult.pointerBases;
              unknownAddressBases = baseResult.unknownPointerBases;
            } else if (baseResult.reference) {
              baseReference = baseResult.reference;
              addressBases = baseResult.addressBases;
              unknownAddressBases = baseResult.unknownAddressBases;
            } else {
              const value = materialize(baseResult, at);
              if (!isAggregate(value.type)) failure('INVALID_MEMBER', 'The . operator requires an aggregate value.', at);
              const temporary = memory.automaticObject(
                node, value.type, frame.fullExpressionToken ?? frame.scopes.at(-1)?.token ?? frame, at,
                { isConst: qualifiersOf(value.type).const },
              );
              memory.write(temporary, value, at, true);
              baseReference = temporary;
              effects = plain(value);
              addressBases = undefined;
            }
            const definition = aggregateDefinition(baseReference.type, at);
            const memberIndex = node.memberIndex ?? definition.members.findIndex((member) => member.name === node.name);
            if (memberIndex < 0 || !definition.members[memberIndex]) failure('UNKNOWN_MEMBER', 'The aggregate has no member named «' + node.name + '».', at);
            const memberReference = memory.member(baseReference, memberIndex, at);
            operands.push(referenceEvaluation(memberReference, node.name, effects, addressBases, unknownAddressBases));
          });
          evaluate(node.base, frame, depth + 1, true, !node.arrow);
        } else if (node.kind === 'conditional') {
          work.push(() => {
            const condition = operands.pop();
            if (!condition) failure('ENGINE_STACK_ERROR', 'Missing condition in ?: expression.', at);
            const conditionResult = materialize(condition, at);
            const conditionBranch = truthValue(conditionResult);
            work.push(() => {
              const result = operands.pop();
              if (!result) failure('ENGINE_STACK_ERROR', 'Missing result for ?: expression.', at);
              const value = valueForType(materialize(result, at), node.type ?? result.value!.type, at);
              const combined = mergeEffects(condition, result, at, true);
              combined.value = value;
              if (isPointer(value.type)) {
                combined.pointerBases = activePointerBases(result.pointerBases);
                combined.unknownPointerBases = unionUnknownPointerBases(
                  result.unknownPointerBases,
                  condition.pointerBases,
                  condition.unknownPointerBases,
                );
              } else if (isInteger(value.type)) {
                propagateIntegerPointerOperation('?:', conditionResult, materialize(result, at), value);
                const conditionPointerBases = isPointer(conditionResult.type)
                  ? unionUnknownPointerBases(condition.pointerBases, condition.unknownPointerBases) : new Set<number>();
                if (conditionPointerBases.size) {
                  const origins = integerPointerOrigins(value);
                  rememberIntegerPointerBases(value, origins.known, unionUnknownPointerBases(origins.unknown, conditionPointerBases));
                }
              }
              operands.push(combined);
            });
            evaluate(conditionBranch ? node.then : node.else, frame, depth + 1, used);
          });
          evaluate(node.condition, frame, depth + 1);
        } else if (node.kind === 'binary') {
          work.push(() => {
            const left = operands.pop();
            if (!left) failure('ENGINE_STACK_ERROR', 'Missing left operand.', at);
            const leftValue = materialize(left, at);
            if ((node.operator === '&&' && !truthValue(leftValue)) || (node.operator === '||' && truthValue(leftValue))) {
              left.value = integer(node.operator === '||' ? 1 : 0);
              propagateIntegerPointerOperation(node.operator, leftValue, undefined, left.value);
              if (isPointer(leftValue.type)) {
                rememberIntegerPointerBases(left.value, [], unionUnknownPointerBases(left.pointerBases, left.unknownPointerBases));
              }
              left.pendingWrites.clear();
              operands.push(left);
              return;
            }
            work.push(() => {
              const right = operands.pop();
              if (!right) failure('ENGINE_STACK_ERROR', 'Missing right operand.', at);
              const rightValue = materialize(right, at);
              const sequenced = [',', '&&', '||'].includes(node.operator);
              const result = node.operator === ','
                ? rightValue
                : node.operator === '&&' || node.operator === '||'
                  ? integer(truthValue(rightValue))
                  : operateBinary(node.operator, leftValue, rightValue, at);
              const combined = mergeEffects(left, right, at, sequenced);
              combined.value = result;
              if (node.operator === ',') {
                combined.pointerBases = activePointerBases(right.pointerBases);
                combined.unknownPointerBases = activeUnknownPointerBases(right.unknownPointerBases);
              } else {
                propagateIntegerPointerOperation(node.operator, leftValue, rightValue, result);
                if (isInteger(result.type)) {
                  const pointerOrigins = unionUnknownPointerBases(
                    isPointer(leftValue.type) ? unionPointerBases(left.pointerBases, right.pointerBases) : undefined,
                    isPointer(rightValue.type) ? unionPointerBases(left.pointerBases, right.pointerBases) : undefined,
                  );
                  if (pointerOrigins.size) {
                    const origins = integerPointerOrigins(result);
                    rememberIntegerPointerBases(result, origins.known, unionUnknownPointerBases(origins.unknown, pointerOrigins));
                  }
                }
                if (isPointer(result.type) && (node.operator === '+' || node.operator === '-')) {
                  const pointerSource = isPointer(leftValue.type) ? left : right;
                  const offsetValue = isPointer(leftValue.type) ? rightValue : leftValue;
                  const offsetOrigins = integerPointerOrigins(offsetValue);
                  combined.pointerBases = activePointerBases(pointerSource.pointerBases);
                  combined.unknownPointerBases = unionUnknownPointerBases(
                    pointerSource.unknownPointerBases,
                    offsetOrigins.known,
                    offsetOrigins.unknown,
                  );
                }
              }
              operands.push(combined);
            });
            evaluate(node.right, frame, depth + 1, node.operator === ',' ? used : true);
          });
          evaluate(node.left, frame, depth + 1, node.operator !== ',');
        } else if (node.kind === 'compoundLiteral') {
          const activeScope = frame.scopes.at(-1);
          const compoundOptions = { isConst: qualifiersOf(node.objectType).const };
          const objectReference = node.duration === 'static'
            ? context.debugEvents
              ? memory.findStaticObject(node) ?? allocateDebugObject(
                () => memory.staticObject(node, node.objectType, at, 'static', compoundOptions),
                {
                  duration: 'static', origin: 'compound-literal',
                  typeSummary: debugTypeSummary(node.objectType, ir.aggregates), location: at,
                  frameId: null, scopeId: null,
                },
              )
              : memory.staticObject(node, node.objectType, at, 'static', compoundOptions)
            : context.debugEvents
              ? (() => {
                const scopeToken = activeScope?.token ?? frame;
                return memory.findAutomaticObject(node, scopeToken) ?? allocateDebugObject(
                  () => memory.automaticObject(node, node.objectType, scopeToken, at, compoundOptions),
                  {
                    duration: 'compound-literal', origin: 'compound-literal',
                    typeSummary: debugTypeSummary(node.objectType, ir.aggregates), location: at,
                    frameId: frame.frameId, scopeId: activeScope?.scopeId ?? null,
                  },
                );
              })()
              : memory.automaticObject(node, node.objectType, activeScope?.token ?? frame, at, compoundOptions);
          if (node.duration === 'static' && initializedStaticExpressions.has(node)) {
            operands.push(referenceEvaluation(objectReference, 'compound literal'));
          } else {
            if (node.duration === 'static') initializedStaticExpressions.add(node);
            work.push(() => operands.push(referenceEvaluation(objectReference, 'compound literal')));
            initializeObject(objectReference, node.objectType, node.initializer, frame, depth + 1);
          }

        }
        else return false;
        return true;
  };
}
