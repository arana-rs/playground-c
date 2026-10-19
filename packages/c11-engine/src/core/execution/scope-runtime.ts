import { enforceLimit, failure } from '../internal.ts';
import type { Binding, CValue, Location, ObjectPointerValue, ObjectReference, ProgramIR, VariablyModifiedIdentifier } from '../internal.ts';
import type { ExecuteLimits } from '../types.ts';
import { hasVariableLengthObjectSize } from '../type-system.ts';
import { qualifiersOf, isInteger, isPointer } from '../type-system.ts';
import type { VirtualMemory } from '../memory.ts';
import type { Scope } from '../bytecode.ts';
import type { DebugEventCollector } from './debug-events.ts';
import { debugTypeSummary } from './debug-format.ts';
import type { DebugObjectMetadata, DebugObjectRecord, Frame, RestrictObservation, RuntimeScope } from './runtime-types.ts';

/** Live VM state used to enter, leave, and jump between lexical scopes. */
export interface ScopeRuntimeContext {
  readonly ir: ProgramIR;
  readonly memory: VirtualMemory;
  readonly limits: Pick<ExecuteLimits, 'maxDepth'>;
  readonly activeRestrictBases: Map<number, object>;
  readonly restrictBaseByPointerObject: Map<number, number>;
  readonly restrictPointerObjectByBase: Map<number, number>;
  readonly restrictBaseParents: Map<number, Set<number>>;
  readonly restrictObservations: Map<number, Map<string, RestrictObservation>>;
  readonly preparedStaticBindings: WeakSet<Binding>;
  readonly pointerValueBases: WeakMap<ObjectPointerValue, Set<number>>;
  readonly unknownPointerValueBases: WeakMap<ObjectPointerValue, Set<number>>;
  readonly integerValueBases: WeakMap<CValue, Set<number>>;
  readonly unknownIntegerValueBases: WeakMap<CValue, Set<number>>;
  readonly debugObjects: Map<number, DebugObjectRecord> | undefined;
  get debugEvents(): DebugEventCollector | undefined;
  get runtimeLocation(): Location;
  get scopeDepth(): number;
  set scopeDepth(value: number);
  get nextDebugScopeId(): number;
  set nextDebugScopeId(value: number);
  readonly hasPersistentDuration: (binding: Binding) => boolean;
  readonly valueForType: (value: CValue, type: CValue['type'], at: Location) => CValue;
  readonly setPointerBasesForObject: (
    reference: ObjectReference,
    bases?: Iterable<number>,
    unknownBases?: Iterable<number>,
  ) => void;
  readonly setIntegerPointerBasesForObject: (
    reference: ObjectReference,
    bases?: Iterable<number>,
    unknownBases?: Iterable<number>,
  ) => void;
  readonly localCell: (frame: Frame, binding: number, at: Location) => { binding: Binding; reference: ObjectReference };
  readonly registerRestrictPointer: (scope: RuntimeScope, binding: Binding, reference: ObjectReference) => void;
  readonly allocateDebugObject: (allocate: () => ObjectReference, metadata: DebugObjectMetadata) => ObjectReference;
  readonly publishAutomaticBinding: (frame: Frame, scope: RuntimeScope, binding: Binding, reference: ObjectReference) => void;
  readonly commitDebugObjectDelete: (
    reference: ObjectReference,
    at: Location,
    frameId: number | null,
    scopeId: number | null,
  ) => void;
}

export interface ScopeRuntime {
  readonly enter: (frame: Frame, layout: Scope) => void;
  readonly leave: (frame: Frame, eventLocation?: Location) => void;
  readonly leaveVariablyModifiedIdentifiers: (
    frame: Frame,
    identifiers: readonly VariablyModifiedIdentifier[],
    targetIdentifiers: readonly VariablyModifiedIdentifier[],
    at: Location,
  ) => void;
  readonly jump: (
    frame: Frame,
    target: number,
    vmScopeExit?: readonly VariablyModifiedIdentifier[],
    vmScopeTarget?: readonly VariablyModifiedIdentifier[],
    at?: Location,
  ) => void;
}

export function createScopeRuntime(context: ScopeRuntimeContext): ScopeRuntime {
  function enter(frame: Frame, layout: Scope): void {
    enforceLimit('maxDepth', context.scopeDepth + 1, context.limits.maxDepth, layout.location);
    const scopeId = context.debugEvents ? context.nextDebugScopeId++ : 0;
    context.debugEvents?.reserve(layout.location);
    const runtimeScope: RuntimeScope = { layout, token: {}, scopeId, cells: [], vlaTypeKeys: [], restrictBases: [] };
    frame.scopes.push(runtimeScope);
    context.scopeDepth++;
    context.debugEvents?.commit({
      kind: 'scope-enter', location: layout.location,
      frameId: frame.frameId, scopeId, functionName: frame.compiled.fn.name, scopeName: layout.name,
    });
    for (const binding of layout.bindings) {
      if (binding.linkage === 'external' || binding.globalBinding !== undefined) continue;
      if (!context.hasPersistentDuration(binding) && hasVariableLengthObjectSize(binding.type)) continue;
      let reference: ObjectReference;
      if (context.hasPersistentDuration(binding)) {
        const duration = binding.storageDuration === 'thread-local' ? 'thread-local' : 'static';
        const options = {
          isConst: binding.isConst === true || qualifiersOf(binding.type).const || binding.qualifiers?.const === true,
          ...(binding.alignment === undefined ? {} : { alignment: binding.alignment }),
        };
        if (context.debugEvents) {
          reference = context.memory.findStaticObject(binding) ?? context.allocateDebugObject(
            () => context.memory.staticObject(binding, binding.type, binding.location, duration, options),
            {
              duration, origin: 'variable', typeSummary: debugTypeSummary(binding.type, context.ir.aggregates),
              location: binding.location, frameId: null, scopeId: null, name: binding.name,
              readOnly: options.isConst,
            },
          );
        } else reference = context.memory.staticObject(binding, binding.type, binding.location, duration, options);
        if (!context.preparedStaticBindings.has(binding)) {
          context.memory.zeroInitialize(reference, binding.location);
          context.preparedStaticBindings.add(binding);
        }
      } else {
        reference = context.memory.allocate(binding.type, 'automatic', binding.location, {
          isConst: binding.isConst === true || qualifiersOf(binding.type).const || binding.qualifiers?.const === true,
          ...(binding.alignment === undefined ? {} : { alignment: binding.alignment }),
        });
      }
      frame.cells.set(binding.id, { binding, reference });
      runtimeScope.cells.push(binding.id);
      context.registerRestrictPointer(runtimeScope, binding, reference);
    }
    if (frame.scopes.length === 1) {
      const parameters = frame.compiled.fn.parameters;
      const hasVariableLengthParameter = parameters.some((parameter) => parameter.variableLengthBounds?.length);
      parameters.forEach((parameter, index) => {
        const target = context.localCell(frame, parameter.binding!, parameter.location);
        const argument = frame.args[index];
        if (!argument) failure('ARGUMENT_COUNT', 'Missing function argument for «' + parameter.name + '».', parameter.location);
        const converted = context.valueForType(argument, parameter.type, parameter.location);
        context.memory.write(target.reference, converted, parameter.location, true);
        if (isPointer(parameter.type)) {
          context.setPointerBasesForObject(
            target.reference,
            frame.argumentPointerBases?.[index] ?? (typeof converted.value === 'object' && converted.value !== null && converted.value.kind === 'object-pointer'
              ? context.pointerValueBases.get(converted.value) : undefined),
            frame.argumentUnknownPointerBases?.[index] ?? (typeof converted.value === 'object' && converted.value !== null && converted.value.kind === 'object-pointer'
              ? context.unknownPointerValueBases.get(converted.value) : undefined),
          );
        }
        if (isInteger(parameter.type)) {
          context.setIntegerPointerBasesForObject(target.reference, context.integerValueBases.get(converted), context.unknownIntegerValueBases.get(converted));
        }
        if (context.debugEvents && !hasVariableLengthParameter) {
          context.publishAutomaticBinding(frame, runtimeScope, target.binding, target.reference);
        }
      });
    }
  }

  function leave(frame: Frame, eventLocation: Location = context.runtimeLocation): void {
    const scope = frame.scopes.at(-1);
    if (!scope) failure('INVALID_SCOPE', 'There is no active scope to close.', context.runtimeLocation);
    for (const base of scope.restrictBases) {
      context.activeRestrictBases.delete(base);
      context.restrictObservations.delete(base);
      context.restrictBaseParents.delete(base);
      for (const [child, parents] of context.restrictBaseParents) {
        parents.delete(base);
        if (!parents.size) context.restrictBaseParents.delete(child);
      }
      const objectId = context.restrictPointerObjectByBase.get(base);
      if (objectId !== undefined && context.restrictBaseByPointerObject.get(objectId) === base) {
        context.restrictBaseByPointerObject.delete(objectId);
      }
      context.restrictPointerObjectByBase.delete(base);
    }
    if (!context.debugEvents || !context.debugObjects) {
      frame.scopes.pop();
      context.scopeDepth--;
      context.memory.releaseScope(scope.token, scope.layout.location);
      for (const bindingId of scope.cells) {
        const target = frame.cells.get(bindingId);
        if (target && !context.hasPersistentDuration(target.binding)) context.memory.release(target.reference, target.binding.location);
        frame.cells.delete(bindingId);
      }
      for (const type of scope.vlaTypeKeys) frame.vlaLengths.delete(type);
      return;
    }

    const compoundReferences = [...context.memory.scopeObjectReferences(scope.token)].reverse();
    const bindingReferences = scope.cells.flatMap((bindingId) => {
      const target = frame.cells.get(bindingId);
      return target && !context.hasPersistentDuration(target.binding) ? [target.reference] : [];
    });
    const trackedReferences = [...compoundReferences, ...bindingReferences]
      .filter((reference) => context.debugObjects!.has(reference.allocationId));
    const uniqueReferences = [...new Map(trackedReferences.map((reference) => [reference.allocationId, reference])).values()];
    const releaseLocation = scope.layout.location;
    context.debugEvents!.reserveMany(uniqueReferences.length + 1, eventLocation);
    frame.scopes.pop();
    context.scopeDepth--;
    try {
      context.memory.releaseScope(scope.token, releaseLocation);
      for (const bindingId of scope.cells) {
        const target = frame.cells.get(bindingId);
        if (target && !context.hasPersistentDuration(target.binding)) context.memory.release(target.reference, target.binding.location);
        frame.cells.delete(bindingId);
      }
      for (const type of scope.vlaTypeKeys) frame.vlaLengths.delete(type);
    } catch (error) {
      let committed = 0;
      for (const reference of uniqueReferences) {
        if (!context.memory.isAlive(reference)) {
          context.commitDebugObjectDelete(reference, eventLocation, frame.frameId, scope.scopeId);
          committed++;
        }
      }
      context.debugEvents!.cancelMany(uniqueReferences.length + 1 - committed);
      throw error;
    }
    for (const reference of uniqueReferences) {
      context.commitDebugObjectDelete(reference, eventLocation, frame.frameId, scope.scopeId);
    }
    context.debugEvents!.commit({
      kind: 'scope-exit', location: eventLocation, frameId: frame.frameId,
      scopeId: scope.scopeId, functionName: frame.compiled.fn.name, scopeName: scope.layout.name,
    });
  }

  function leaveVariablyModifiedIdentifiers(
    frame: Frame,
    identifiers: readonly VariablyModifiedIdentifier[],
    targetIdentifiers: readonly VariablyModifiedIdentifier[],
    at: Location,
  ): void {
    const retainedArrayTypes = new Set(targetIdentifiers.flatMap((identifier) => identifier.arrayTypes));
    for (const identifier of identifiers) {
      for (const arrayType of identifier.arrayTypes) {
        if (!retainedArrayTypes.has(arrayType)) frame.vlaLengths.delete(arrayType);
      }
      if (identifier.vlaBinding === undefined) continue;
      const cell = frame.cells.get(identifier.vlaBinding);
      if (!cell) continue;

      const shouldTraceDelete = !!context.debugEvents && !!context.debugObjects && context.debugObjects.has(cell.reference.allocationId);
      if (shouldTraceDelete) context.debugEvents!.reserve(at);
      try {
        context.memory.release(cell.reference, at);
      } catch (error) {
        if (shouldTraceDelete) context.debugEvents!.cancel();
        throw error;
      }
      if (shouldTraceDelete) {
        const owner = frame.scopes.find((scope) => scope.cells.includes(identifier.vlaBinding!));
        context.commitDebugObjectDelete(cell.reference, at, frame.frameId, owner?.scopeId ?? null);
      }
      frame.cells.delete(identifier.vlaBinding);
      for (const scope of frame.scopes) {
        for (let index = scope.cells.length - 1; index >= 0; index--) {
          if (scope.cells[index] === identifier.vlaBinding) scope.cells.splice(index, 1);
        }
      }
    }
  }

  function jump(
    frame: Frame,
    target: number,
    vmScopeExit?: readonly VariablyModifiedIdentifier[],
    vmScopeTarget?: readonly VariablyModifiedIdentifier[],
    at: Location = context.runtimeLocation,
  ): void {
    if (vmScopeExit?.length) {
      leaveVariablyModifiedIdentifiers(frame, vmScopeExit, vmScopeTarget ?? [], at);
    }
    const path = frame.compiled.code[target]?.path ?? [];
    let shared = 0;
    while (shared < path.length && shared < frame.scopes.length && path[shared] === frame.scopes[shared].layout) shared++;
    while (frame.scopes.length > shared) leave(frame);
    for (let index = shared; index < path.length; index++) enter(frame, path[index]);
    frame.pc = target;
  }

  return { enter, leave, leaveVariablyModifiedIdentifiers, jump };
}
