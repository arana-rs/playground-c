import { failure } from '../internal.ts';
import type { CValue, Expression, Location, ObjectPointerValue, ObjectReference } from '../internal.ts';
import { isArray, isFunction, isInteger, isPointer } from '../type-system.ts';
import type { VirtualMemory } from '../memory.ts';
import type { Access, Evaluation, Frame } from './runtime-types.ts';

/** Live state used to build and consume expression access effects. */
export interface EffectsRuntimeContext {
  readonly memory: VirtualMemory;
  readonly pointerValueBases: WeakMap<ObjectPointerValue, Set<number>>;
  readonly unknownPointerValueBases: WeakMap<ObjectPointerValue, Set<number>>;
  readonly work: Array<() => void>;
  get runtimeLocation(): Location;
  readonly activePointerBases: (bases?: Iterable<number>) => Set<number>;
  readonly activeUnknownPointerBases: (bases?: Iterable<number>) => Set<number>;
  readonly unionPointerBases: (...sources: Array<Iterable<number> | undefined>) => Set<number>;
  readonly unionUnknownPointerBases: (...sources: Array<Iterable<number> | undefined>) => Set<number>;
  readonly rememberPointerBases: (value: CValue, bases?: Iterable<number>, unknownBases?: Iterable<number>) => void;
  readonly rememberIntegerPointerBases: (value: CValue, bases?: Iterable<number>, unknownBases?: Iterable<number>) => void;
  readonly pointerBasesForObject: (reference: ObjectReference) => Set<number>;
  readonly unknownPointerBasesForObject: (reference: ObjectReference) => Set<number>;
  readonly integerPointerBasesForObject: (reference: ObjectReference) => Set<number>;
  readonly unknownIntegerPointerBasesForObject: (reference: ObjectReference) => Set<number>;
  readonly observeRestrictAccess: (
    reference: ObjectReference,
    addressBases: Iterable<number> | undefined,
    unknownAddressBases: Iterable<number> | undefined,
    write: boolean,
    at: Location,
  ) => void;
  readonly clearIntegerPointerOriginsInRange: (allocationId: number, byteOffset: number, byteCount: number) => void;
  readonly evaluate: (root: Expression, frame: Frame, depth?: number, used?: boolean, wantLvalue?: boolean) => void;
}

export interface EffectsRuntime {
  readonly addAccess: (evaluation: Evaluation, objectId: number, access: Access) => void;
  readonly mergeEffects: (left: Evaluation, right: Evaluation, at: Location, sequenced?: boolean) => Evaluation;
  readonly referenceEvaluation: (
    reference: ObjectReference,
    label: string,
    effects?: Evaluation,
    addressBases?: Iterable<number>,
    unknownAddressBases?: Iterable<number>,
  ) => Evaluation;
  readonly markRead: (evaluation: Evaluation, reference: ObjectReference, label: string) => void;
  readonly markWrite: (evaluation: Evaluation, reference: ObjectReference, label: string) => void;
  readonly materialize: (evaluation: Evaluation, at: Location) => CValue;
  readonly evaluateFullExpression: (
    expression: Expression,
    frame: Frame,
    consume: () => void,
    depth?: number,
    used?: boolean,
  ) => void;
}

export function createEffectsRuntime(context: EffectsRuntimeContext): EffectsRuntime {
  const addAccess = (evaluation: Evaluation, objectId: number, access: Access): void => {
    const previous = evaluation.accesses.get(objectId);
    evaluation.accesses.set(objectId, {
      read: access.read || !!previous?.read,
      write: access.write || !!previous?.write,
      name: previous?.name ?? access.name,
    });
  };
  const mergeEffects = (left: Evaluation, right: Evaluation, at: Location, sequenced = false): Evaluation => {
    const accesses = new Map(left.accesses);
    for (const [objectId, access] of right.accesses) {
      const previous = accesses.get(objectId);
      if (!sequenced && previous && ((previous.write && (access.write || access.read)) ||
          (access.write && previous.read))) {
        failure('UNSEQUENCED_ACCESS', 'Unsequenced accesses to «' + (previous.name || access.name) + '»: undefined behavior in C11.', at);
      }
      accesses.set(objectId, {
        read: access.read || !!previous?.read,
        write: access.write || !!previous?.write,
        name: previous?.name ?? access.name,
      });
    }
    return {
      accesses,
      pendingWrites: sequenced ? new Set(right.pendingWrites) : new Set([...left.pendingWrites, ...right.pendingWrites]),
    };
  };
  const referenceEvaluation = (
    reference: ObjectReference,
    label: string,
    effects?: Evaluation,
    addressBases?: Iterable<number>,
    unknownAddressBases?: Iterable<number>,
  ): Evaluation => ({
    reference,
    label,
    accesses: effects ? new Map(effects.accesses) : new Map(),
    pendingWrites: effects ? new Set(effects.pendingWrites) : new Set(),
    ...(addressBases === undefined ? {} : { addressBases: context.activePointerBases(addressBases) }),
    ...(unknownAddressBases === undefined ? {} : { unknownAddressBases: context.activeUnknownPointerBases(unknownAddressBases) }),
  });
  const markRead = (evaluation: Evaluation, reference: ObjectReference, label: string): void => {
    addAccess(evaluation, reference.objectId, { read: true, write: false, name: label });
    context.observeRestrictAccess(reference, evaluation.addressBases, evaluation.unknownAddressBases, false, context.runtimeLocation);
  };
  const markWrite = (evaluation: Evaluation, reference: ObjectReference, label: string): void => {
    addAccess(evaluation, reference.objectId, { read: false, write: true, name: label });
    context.observeRestrictAccess(reference, evaluation.addressBases, evaluation.unknownAddressBases, true, context.runtimeLocation);
    const view = context.memory.describeObjectView(reference, context.runtimeLocation);
    context.clearIntegerPointerOriginsInRange(view.allocationId, reference.byteOffset, view.size);
    evaluation.pendingWrites.add(reference.objectId);
  };
  const materialize = (evaluation: Evaluation, at: Location): CValue => {
    if (evaluation.value) {
      const pointer = typeof evaluation.value.value === 'object' && evaluation.value.value !== null &&
        evaluation.value.value.kind === 'object-pointer' ? evaluation.value.value : undefined;
      if (pointer) {
        evaluation.pointerBases = context.activePointerBases(evaluation.pointerBases ?? context.pointerValueBases.get(pointer));
        evaluation.unknownPointerBases = context.activeUnknownPointerBases(
          evaluation.unknownPointerBases ?? context.unknownPointerValueBases.get(pointer),
        );
        context.rememberPointerBases(evaluation.value, evaluation.pointerBases, evaluation.unknownPointerBases);
      }
      return evaluation.value;
    }
    const reference = evaluation.reference;
    if (!reference) failure('INVALID_LVALUE', 'The expression designates neither a value nor an object.', at);
    if (isArray(reference.type)) {
      evaluation.value = context.memory.decay(reference);
      evaluation.pointerBases = context.activePointerBases(evaluation.addressBases);
      evaluation.unknownPointerBases = context.activeUnknownPointerBases(evaluation.unknownAddressBases);
    } else if (isFunction(reference.type)) {
      failure('INVALID_OBJECT', 'A function cannot be read as an object.', at);
    } else {
      evaluation.value = context.memory.read(reference, at);
      markRead(evaluation, reference, evaluation.label ?? 'object');
      if (isPointer(reference.type)) {
        evaluation.pointerBases = context.unionPointerBases(
          context.pointerBasesForObject(reference),
          typeof evaluation.value.value === 'object' && evaluation.value.value !== null && evaluation.value.value.kind === 'object-pointer'
            ? context.pointerValueBases.get(evaluation.value.value) : undefined,
        );
        evaluation.unknownPointerBases = context.unionUnknownPointerBases(
          context.unknownPointerBasesForObject(reference),
          typeof evaluation.value.value === 'object' && evaluation.value.value !== null && evaluation.value.value.kind === 'object-pointer'
            ? context.unknownPointerValueBases.get(evaluation.value.value) : undefined,
        );
        context.rememberPointerBases(evaluation.value, evaluation.pointerBases, evaluation.unknownPointerBases);
      } else if (isInteger(reference.type)) {
        context.rememberIntegerPointerBases(
          evaluation.value,
          context.integerPointerBasesForObject(reference),
          context.unknownIntegerPointerBasesForObject(reference),
        );
      }
    }
    evaluation.reference = undefined;
    context.rememberPointerBases(evaluation.value, evaluation.pointerBases, evaluation.unknownPointerBases);
    return evaluation.value;
  };

  function evaluateFullExpression(
    expression: Expression,
    frame: Frame,
    consume: () => void,
    depth = 1,
    used = true,
  ): void {
    const previousToken = frame.fullExpressionToken;
    const token = {};
    frame.fullExpressionToken = token;
    // Keep aggregate rvalue storage alive while the enclosing expression is
    // consumed, then end the temporary objects' lifetime before the next op.
    context.work.push(() => {
      try { consume(); }
      finally {
        context.memory.releaseScope(token, expression.location);
        frame.fullExpressionToken = previousToken;
      }
    });
    context.evaluate(expression, frame, depth, used);
  }

  return {
    addAccess,
    mergeEffects,
    referenceEvaluation,
    markRead,
    markWrite,
    materialize,
    evaluateFullExpression,
  };
}
