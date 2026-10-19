import { failure } from '../internal.ts';
import type { CValue, Location, ObjectPointerValue, ObjectReference } from '../internal.ts';
import { convert } from '../numeric.ts';
import {
  aggregateType, isFunction, isInteger, isPointer, pointedToType, pointerType,
  sameType, unqualifiedType,
} from '../type-system.ts';
import type { PointerRuntime, PointerRuntimeContext } from './pointer-runtime-context.ts';

export function createPointerRuntime(context: PointerRuntimeContext): PointerRuntime {
  const {
    ir, memory, activeRestrictBases, restrictBaseByPointerObject, restrictBaseParents,
    pointerOriginsByObject, unknownPointerOriginsByObject, integerPointerOriginsByObject,
    unknownIntegerPointerOriginsByObject, integerPointerOriginReferences, pointerValueBases,
    unknownPointerValueBases, integerValueBases, unknownIntegerValueBases, integer,
  } = context;
    const valueForType = (value: CValue, type: CValue['type'], at: Location): CValue => {
      const targetType = unqualifiedType(type);
      if (targetType === '_Bool' && (isPointer(value.type) || value.value === null ||
          (typeof value.value === 'object' && value.value !== null &&
            ((value.value as { kind?: string }).kind === 'object-pointer' || (value.value as { kind?: string }).kind === 'function-pointer')))) {
        return integer(value.value !== null, '_Bool');
      }
      if (isInteger(targetType) && isPointer(value.type)) {
        const converted = convert({ type: 'unsigned long', value: memory.pointerInteger(value, at) }, targetType, at, ir.aggregates);
        if (typeof value.value === 'object' && value.value !== null && value.value.kind === 'object-pointer') {
          rememberIntegerPointerBases(
            converted, pointerValueBases.get(value.value), unknownPointerValueBases.get(value.value),
          );
        }
        return converted;
      }
      if (pointerType(targetType)) {
        if (value.value === null) return { type: targetType, value: null };
        if (typeof value.value === 'bigint' && value.value === 0n) return { type: targetType, value: null };
        if (typeof value.value === 'bigint') {
          const converted = memory.pointerFromInteger(value.value, targetType, at);
          rememberPointerBases(converted, integerValueBases.get(value), unknownIntegerValueBases.get(value));
          return converted;
        }
        if (typeof value.value === 'object' && value.value !== null) {
          const kind = (value.value as { kind?: string }).kind;
          if (kind === 'object-pointer') {
            if (isFunction(pointedToType(targetType) ?? 'void')) failure('INVALID_POINTER_CONVERSION', 'An object pointer cannot be converted to a function pointer.', at);
            const converted = { type: targetType, value: value.value as ObjectPointerValue };
            rememberPointerBases(converted, pointerValueBases.get(value.value as ObjectPointerValue), unknownPointerValueBases.get(value.value as ObjectPointerValue));
            return converted;
          }
          if (kind === 'function-pointer') {
            if (!isFunction(pointedToType(targetType) ?? 'void')) failure('INVALID_POINTER_CONVERSION', 'A function pointer cannot be converted to an object pointer.', at);
            return { type: targetType, value: value.value };
          }
        }
        failure('INVALID_POINTER_CONVERSION', 'Pointer conversion requires a compatible pointer or a null pointer constant.', at);
      }
      const targetAggregate = aggregateType(targetType);
      const valueAggregate = aggregateType(value.type);
      if (targetAggregate) {
        if (valueAggregate && valueAggregate.id === targetAggregate.id &&
            typeof value.value === 'object' && value.value !== null &&
            (value.value as { kind?: string }).kind === 'aggregate-value') {
          return { type: targetType, value: value.value };
        }
        failure('INVALID_AGGREGATE_CONVERSION', 'By-value conversion requires the same struct or union type.', at);
      }
      const converted = convert(value, targetType, at, ir.aggregates);
      if (isInteger(targetType) && isInteger(value.type)) {
        if (sameType(unqualifiedType(targetType), unqualifiedType(value.type))) {
          preserveIntegerPointerBases(value, converted);
        } else {
          const origins = integerPointerOrigins(value);
          rememberIntegerPointerBases(converted, [], unionUnknownPointerBases(origins.known, origins.unknown));
        }
      }
      return converted;
    };
    const activePointerBases = (bases?: Iterable<number>): Set<number> => new Set(
      [...(bases ?? [])].filter((base) => activeRestrictBases.has(base)),
    );
    const activeUnknownPointerBases = (bases?: Iterable<number>): Set<number> => new Set(
      [...(bases ?? [])].filter((base) => activeRestrictBases.has(base)),
    );
    const unionPointerBases = (...sources: Array<Iterable<number> | undefined>): Set<number> =>
      activePointerBases(sources.flatMap((source) => [...(source ?? [])]));
    const unionUnknownPointerBases = (...sources: Array<Iterable<number> | undefined>): Set<number> =>
      activeUnknownPointerBases(sources.flatMap((source) => [...(source ?? [])]));
    const rememberPointerBases = (
      value: CValue,
      bases?: Iterable<number>,
      unknownBases?: Iterable<number>,
    ): void => {
      if (!isPointer(value.type) || typeof value.value !== 'object' || value.value === null || value.value.kind !== 'object-pointer') return;
      pointerValueBases.set(value.value, activePointerBases(bases));
      unknownPointerValueBases.set(value.value, activeUnknownPointerBases(unknownBases));
    };
    const rememberIntegerPointerBases = (
      value: CValue,
      bases?: Iterable<number>,
      unknownBases?: Iterable<number>,
    ): void => {
      if (!isInteger(value.type)) return;
      const filtered = activePointerBases(bases);
      const unknown = activeUnknownPointerBases(unknownBases);
      if (filtered.size) integerValueBases.set(value, filtered);
      else integerValueBases.delete(value);
      if (unknown.size) unknownIntegerValueBases.set(value, unknown);
      else unknownIntegerValueBases.delete(value);
    };
    const preserveIntegerPointerBases = (source: CValue, target: CValue): void => {
      rememberIntegerPointerBases(target, integerValueBases.get(source), unknownIntegerValueBases.get(source));
    };
    const pointerBasesForObject = (reference: ObjectReference): Set<number> => {
      const bases = activePointerBases(pointerOriginsByObject.get(reference.objectId));
      const ownBase = restrictBaseByPointerObject.get(reference.objectId);
      if (ownBase !== undefined && activeRestrictBases.has(ownBase)) bases.add(ownBase);
      return bases;
    };
    const unknownPointerBasesForObject = (reference: ObjectReference): Set<number> =>
      activeUnknownPointerBases(unknownPointerOriginsByObject.get(reference.objectId));
    const setPointerBasesForObject = (
      reference: ObjectReference,
      bases?: Iterable<number>,
      unknownBases?: Iterable<number>,
    ): void => {
      if (!isPointer(reference.type)) {
        pointerOriginsByObject.delete(reference.objectId);
        unknownPointerOriginsByObject.delete(reference.objectId);
        return;
      }
      const filtered = activePointerBases(bases);
      pointerOriginsByObject.set(reference.objectId, filtered);
      unknownPointerOriginsByObject.set(reference.objectId, activeUnknownPointerBases(unknownBases));
      const ownBase = restrictBaseByPointerObject.get(reference.objectId);
      if (ownBase !== undefined && activeRestrictBases.has(ownBase)) {
        const parents = new Set([...filtered].filter((base) => base !== ownBase));
        if (parents.size) restrictBaseParents.set(ownBase, parents);
        else restrictBaseParents.delete(ownBase);
      }
    };
    const integerPointerBasesForObject = (reference: ObjectReference): Set<number> =>
      activePointerBases(integerPointerOriginsByObject.get(reference.objectId));
    const unknownIntegerPointerBasesForObject = (reference: ObjectReference): Set<number> =>
      activeUnknownPointerBases(unknownIntegerPointerOriginsByObject.get(reference.objectId));
    const setIntegerPointerBasesForObject = (
      reference: ObjectReference,
      bases?: Iterable<number>,
      unknownBases?: Iterable<number>,
    ): void => {
      if (!isInteger(reference.type)) {
        integerPointerOriginsByObject.delete(reference.objectId);
        unknownIntegerPointerOriginsByObject.delete(reference.objectId);
        integerPointerOriginReferences.delete(reference.objectId);
        return;
      }
      const known = activePointerBases(bases);
      const unknown = activeUnknownPointerBases(unknownBases);
      if (known.size || unknown.size) {
        integerPointerOriginsByObject.set(reference.objectId, known);
        unknownIntegerPointerOriginsByObject.set(reference.objectId, unknown);
        integerPointerOriginReferences.set(reference.objectId, reference);
      } else {
        integerPointerOriginsByObject.delete(reference.objectId);
        unknownIntegerPointerOriginsByObject.delete(reference.objectId);
        integerPointerOriginReferences.delete(reference.objectId);
      }
    };
    const clearIntegerPointerOriginsInRange = (allocationId: number, byteOffset: number, byteCount: number): void => {
      if (!integerPointerOriginReferences.size || byteCount <= 0) return;
      const end = byteOffset + byteCount;
      for (const [objectId, reference] of integerPointerOriginReferences) {
        if (!memory.isAlive(reference)) {
          integerPointerOriginReferences.delete(objectId);
          integerPointerOriginsByObject.delete(objectId);
          unknownIntegerPointerOriginsByObject.delete(objectId);
          continue;
        }
        const view = memory.describeObjectView(reference, context.runtimeLocation);
        if (view.allocationId === allocationId && view.size > 0 &&
            reference.byteOffset < end && byteOffset < reference.byteOffset + view.size) {
          integerPointerOriginReferences.delete(objectId);
          integerPointerOriginsByObject.delete(objectId);
          unknownIntegerPointerOriginsByObject.delete(objectId);
        }
      }
    };
    const copyIntegerPointerOrigins = (
      allocationId: number,
      byteOffset: number,
      byteCount: number,
    ): readonly { relativeOffset: number; size: number; known: Set<number>; unknown: Set<number> }[] => {
      if (!integerPointerOriginReferences.size || byteCount <= 0) return [];
      const end = byteOffset + byteCount;
      const copied: Array<{ relativeOffset: number; size: number; known: Set<number>; unknown: Set<number> }> = [];
      for (const [objectId, reference] of integerPointerOriginReferences) {
        if (!memory.isAlive(reference)) continue;
        const view = memory.describeObjectView(reference, context.runtimeLocation);
        if (view.allocationId !== allocationId || reference.byteOffset < byteOffset || reference.byteOffset + view.size > end) continue;
        const known = activePointerBases(integerPointerOriginsByObject.get(objectId));
        const unknown = activeUnknownPointerBases(unknownIntegerPointerOriginsByObject.get(objectId));
        if (known.size || unknown.size) copied.push({ relativeOffset: reference.byteOffset - byteOffset, size: view.size, known, unknown });
      }
      return copied;
    };
    const restoreIntegerPointerOrigins = (
      allocationId: number,
      byteOffset: number,
      byteCount: number,
      copied: readonly { relativeOffset: number; size: number; known: Set<number>; unknown: Set<number> }[],
    ): void => {
      const targets = memory.integerObjectViewsInRange(allocationId, byteOffset, byteCount);
      for (const origin of copied) {
        const target = targets.find((reference) => {
          const view = memory.describeObjectView(reference, context.runtimeLocation);
          return reference.byteOffset === byteOffset + origin.relativeOffset && view.size === origin.size;
        });
        if (target) setIntegerPointerBasesForObject(target, origin.known, origin.unknown);
      }
    };
    const integerPointerOrigins = (value: CValue): { known: Set<number>; unknown: Set<number> } => ({
      known: activePointerBases(integerValueBases.get(value)),
      unknown: activeUnknownPointerBases(unknownIntegerValueBases.get(value)),
    });
    const hasIntegerPointerOrigins = (origins: { known: Set<number>; unknown: Set<number> }): boolean =>
      origins.known.size > 0 || origins.unknown.size > 0;
    const propagateIntegerPointerOperation = (
      operator: string,
      left: CValue,
      right: CValue | undefined,
      result: CValue,
    ): void => {
      if (!isInteger(result.type)) return;
      const leftOrigins = integerPointerOrigins(left);
      const rightOrigins = right ? integerPointerOrigins(right) : { known: new Set<number>(), unknown: new Set<number>() };
      const dependent = hasIntegerPointerOrigins(leftOrigins) || hasIntegerPointerOrigins(rightOrigins);
      if (!dependent) return;
      const known = unionPointerBases(leftOrigins.known, rightOrigins.known);
      const unknown = unionUnknownPointerBases(leftOrigins.unknown, rightOrigins.unknown);
      const unaryBijective = right === undefined && ['+', '-', '~'].includes(operator);
      const oneDependentOperand = hasIntegerPointerOrigins(leftOrigins) !== hasIntegerPointerOrigins(rightOrigins);
      const additiveBijective = right !== undefined && ['+', '-'].includes(operator) && oneDependentOperand;
      const leftDependent = hasIntegerPointerOrigins(leftOrigins);
      const rightDependent = hasIntegerPointerOrigins(rightOrigins);
      const multiplicativeIdentity = operator === '*' && oneDependentOperand &&
        (leftDependent && right?.value === 1n || rightDependent && left.value === 1n);
      const divisionIdentity = operator === '/' && leftDependent && !rightDependent && right?.value === 1n;
      if (unaryBijective || additiveBijective || multiplicativeIdentity || divisionIdentity) rememberIntegerPointerBases(result, known, unknown);
      else rememberIntegerPointerBases(result, [], unionUnknownPointerBases(known, unknown));
    };

  return {
    valueForType, activePointerBases, activeUnknownPointerBases, unionPointerBases, unionUnknownPointerBases,
    rememberPointerBases, rememberIntegerPointerBases, preserveIntegerPointerBases,
    pointerBasesForObject, unknownPointerBasesForObject, setPointerBasesForObject,
    integerPointerBasesForObject, unknownIntegerPointerBasesForObject, setIntegerPointerBasesForObject,
    clearIntegerPointerOriginsInRange, copyIntegerPointerOrigins, restoreIntegerPointerOrigins,
    integerPointerOrigins, hasIntegerPointerOrigins, propagateIntegerPointerOperation,
  };
}
