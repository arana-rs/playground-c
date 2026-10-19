import { failure } from '../internal.ts';
import type { CValue, Expression } from '../internal.ts';
import { isAggregate, isArray, isFunction, isInteger, isPointer } from '../type-system.ts';
import { binary } from '../numeric.ts';
import type { ExpressionHandler, ExpressionRuntimeContext } from './expression-runtime-context.ts';
import type { Frame } from './runtime-types.ts';

export function createMutationExpressionHandler(context: ExpressionRuntimeContext): ExpressionHandler {
  const {
    memory, work, operands, plain, integer,
    valueForType, activePointerBases, activeUnknownPointerBases, integerValueBases, unknownIntegerValueBases,
    unionPointerBases, unionUnknownPointerBases, rememberIntegerPointerBases, propagateIntegerPointerOperation, pointerBasesForObject,
    unknownPointerBasesForObject, integerPointerBasesForObject, unknownIntegerPointerBasesForObject, setPointerBasesForObject, setIntegerPointerBasesForObject,
    mergeEffects, markRead, markWrite, materialize, evaluate,
    operateBinary
  } = context;
  return (node: Expression, frame: Frame, depth: number, _used: boolean): boolean => {
    const at = node.location;
        if (node.kind === 'update') {
          work.push(() => {
            const target = operands.pop();
            if (!target?.reference) failure('INVALID_LVALUE', 'Increment requires a modifiable object.', at);
            const reference = target.reference;
            if (isArray(reference.type) || isAggregate(reference.type) || isFunction(reference.type)) {
              failure('INVALID_LVALUE', 'Increment requires a modifiable scalar.', at);
            }
            const old = memory.read(reference, at);
            if (isInteger(old.type)) {
              rememberIntegerPointerBases(
                old, integerPointerBasesForObject(reference), unknownIntegerPointerBasesForObject(reference),
              );
            }
            const readEvaluation = plain(old);
            readEvaluation.addressBases = activePointerBases(target.addressBases);
            readEvaluation.unknownAddressBases = activeUnknownPointerBases(target.unknownAddressBases);
            markRead(readEvaluation, reference, target.label ?? 'object');
            const combined = mergeEffects(target, readEvaluation, at);
            combined.addressBases = activePointerBases(target.addressBases);
            combined.unknownAddressBases = activeUnknownPointerBases(target.unknownAddressBases);
            const oldPointerBases = isPointer(old.type) ? pointerBasesForObject(reference) : undefined;
            const oldUnknownPointerBases = isPointer(old.type) ? unknownPointerBasesForObject(reference) : undefined;
            let next: CValue;
            if (isPointer(old.type)) next = memory.pointerAdd(old, node.operator === '++' ? 1n : -1n, at);
            else {
              next = binary(node.operator === '++' ? '+' : '-', old, integer(1), at);
              propagateIntegerPointerOperation(node.operator === '++' ? '+' : '-', old, integer(1), next);
            }
            next = valueForType(next, reference.type, at);
            const nextIntegerBases = isInteger(reference.type) ? integerValueBases.get(next) : undefined;
            const nextUnknownIntegerBases = isInteger(reference.type) ? unknownIntegerValueBases.get(next) : undefined;
            next = memory.write(reference, next, at);
            if (isPointer(reference.type)) setPointerBasesForObject(reference, oldPointerBases, oldUnknownPointerBases);
            markWrite(combined, reference, target.label ?? 'object');
            combined.value = node.prefix ? next : old;
            if (isPointer(next.type)) {
              combined.pointerBases = oldPointerBases;
              combined.unknownPointerBases = oldUnknownPointerBases;
            }
            if (isInteger(reference.type)) setIntegerPointerBasesForObject(reference, nextIntegerBases, nextUnknownIntegerBases);
            if (isInteger(reference.type)) rememberIntegerPointerBases(next, nextIntegerBases, nextUnknownIntegerBases);
            operands.push(combined);
          });
          evaluate(node.operand, frame, depth + 1, true, true);
        } else if (node.kind === 'assignment') {
          work.push(() => {
            const target = operands.pop();
            if (!target?.reference) failure('INVALID_LVALUE', 'Assignment requires a modifiable object.', at);
            const reference = target.reference;
            if (isArray(reference.type) || isAggregate(reference.type) && node.operator !== '=' || isFunction(reference.type)) {
              failure('INVALID_LVALUE', 'The assignment target is not a modifiable scalar.', at);
            }
            const name = target.label ?? 'object';
            let old: CValue | undefined;
            let oldPointerBases: Set<number> | undefined;
            let oldUnknownPointerBases: Set<number> | undefined;
            if (node.operator !== '=') {
              old = memory.read(reference, at);
              if (isInteger(old.type)) {
                rememberIntegerPointerBases(
                  old, integerPointerBasesForObject(reference), unknownIntegerPointerBasesForObject(reference),
                );
              }
              oldPointerBases = isPointer(old.type) ? pointerBasesForObject(reference) : undefined;
              oldUnknownPointerBases = isPointer(old.type) ? unknownPointerBasesForObject(reference) : undefined;
              const oldEvaluation = plain(old);
              oldEvaluation.addressBases = activePointerBases(target.addressBases);
              oldEvaluation.unknownAddressBases = activeUnknownPointerBases(target.unknownAddressBases);
              markRead(oldEvaluation, reference, name);
            }
            work.push(() => {
              const right = operands.pop();
              if (!right) failure('ENGINE_STACK_ERROR', 'Missing right-hand assignment value.', at);
              let effects = mergeEffects(target, right, at);
              // The write belongs to the lvalue's storage path. mergeEffects
              // deliberately does not merge address provenance from unrelated
              // value operands, so restore the target's provenance explicitly.
              effects.addressBases = activePointerBases(target.addressBases);
              effects.unknownAddressBases = activeUnknownPointerBases(target.unknownAddressBases);
              let value = materialize(right, at);
              if (old) {
                const operator = node.operator.slice(0, -1);
                const rightValue = value;
                value = operateBinary(operator, old, rightValue, at);
                propagateIntegerPointerOperation(operator, old, rightValue, value);
              }
              if (right.pendingWrites.has(reference.objectId)) {
                failure('UNSEQUENCED_ACCESS', 'Unsequenced writes to «' + name + '».', at);
              }
              value = valueForType(value, reference.type, at);
              const nextIntegerBases = isInteger(reference.type) ? integerValueBases.get(value) : undefined;
              const nextUnknownIntegerBases = isInteger(reference.type) ? unknownIntegerValueBases.get(value) : undefined;
              value = memory.write(reference, value, at);
              const storedPointerBases = isPointer(reference.type)
                ? node.operator === '=' ? right.pointerBases : unionPointerBases(oldPointerBases, right.pointerBases)
                : undefined;
              const storedUnknownPointerBases = isPointer(reference.type)
                ? node.operator === '=' ? right.unknownPointerBases : unionUnknownPointerBases(oldUnknownPointerBases, right.unknownPointerBases)
                : undefined;
              setPointerBasesForObject(reference, storedPointerBases, storedUnknownPointerBases);
              markWrite(effects, reference, name);
              if (isInteger(reference.type)) {
                setIntegerPointerBasesForObject(reference, nextIntegerBases, nextUnknownIntegerBases);
                rememberIntegerPointerBases(value, nextIntegerBases, nextUnknownIntegerBases);
              }
              effects.value = value;
              if (isPointer(value.type)) {
                effects.pointerBases = storedPointerBases;
                effects.unknownPointerBases = storedUnknownPointerBases;
              }
              operands.push(effects);
            });
            evaluate(node.value, frame, depth + 1);
          });
          evaluate(node.target, frame, depth + 1, true, true);

        }
        else return false;
        return true;
  };
}
