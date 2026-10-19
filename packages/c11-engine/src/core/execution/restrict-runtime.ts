import { failure } from '../internal.ts';
import type { Binding, Location, ObjectReference } from '../internal.ts';
import { isPointer, qualifiersOf } from '../type-system.ts';
import type { RestrictRuntime, RestrictRuntimeContext } from './restrict-runtime-context.ts';
import type { RuntimeScope } from './runtime-types.ts';

export function createRestrictRuntime(context: RestrictRuntimeContext): RestrictRuntime {
  const {
    memory, activeRestrictBases, restrictBaseByPointerObject, restrictPointerObjectByBase,
    restrictBaseParents, restrictObservations, activePointerBases, activeUnknownPointerBases,
  } = context;
    const registerRestrictPointer = (scope: RuntimeScope, binding: Binding, reference: ObjectReference): void => {
      if (!isPointer(binding.type) || !qualifiersOf(binding.type).restrict) return;
      const base = context.nextRestrictBaseId++;
      activeRestrictBases.set(base, scope.token);
      restrictBaseByPointerObject.set(reference.objectId, base);
      restrictPointerObjectByBase.set(base, reference.objectId);
      scope.restrictBases.push(base);
    };
    const relatedRestrictBases = (base: number): Set<number> => {
      const related = new Set<number>([base]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [child, parents] of restrictBaseParents) {
          if (!activeRestrictBases.has(child)) continue;
          if (related.has(child) || [...parents].some((parent) => related.has(parent))) {
            if (!related.has(child)) { related.add(child); changed = true; }
            for (const parent of parents) {
              if (activeRestrictBases.has(parent) && !related.has(parent)) {
                related.add(parent);
                changed = true;
              }
            }
          }
        }
      }
      return related;
    };
    const observeRestrictRange = (
      allocationId: number,
      byteOffset: number,
      byteCount: number,
      addressBases: Iterable<number> | undefined,
      unknownAddressBases: Iterable<number> | undefined,
      write: boolean,
      at: Location,
      bitMask?: bigint,
    ): void => {
      const bases = activePointerBases(addressBases);
      const unknownBases = activeUnknownPointerBases(unknownAddressBases);
      if (!activeRestrictBases.size || !byteCount) return;
      for (let byteIndex = 0; byteIndex < byteCount; byteIndex++) {
        const byteMask = bitMask === undefined
          ? 0xff
          : Number((bitMask >> BigInt(byteIndex * 8)) & 0xffn);
        if (!byteMask) continue;
        const key = `${allocationId}:${byteOffset + byteIndex}`;
        for (const base of activeRestrictBases.keys()) {
          let objects = restrictObservations.get(base);
          if (!objects) restrictObservations.set(base, objects = new Map());
          let observation = objects.get(key);
          if (!observation) objects.set(key, observation = {
            accessedViaBaseMask: 0, independentAccessMask: 0, unknownAccessMask: 0, modifiedMask: 0,
          });
          const related = relatedRestrictBases(base);
          if ([...bases].some((candidate) => related.has(candidate))) {
            observation.accessedViaBaseMask |= byteMask;
          } else if ([...unknownBases].some((candidate) => related.has(candidate))) {
            observation.unknownAccessMask |= byteMask;
          } else {
            observation.independentAccessMask |= byteMask;
          }
          if (write) observation.modifiedMask |= byteMask;
          if (observation.accessedViaBaseMask & observation.independentAccessMask & observation.modifiedMask) {
            failure('RESTRICT_ALIAS', `Storage at byte offset ${byteOffset + byteIndex} was accessed through unrelated pointer associations and modified within their scope.`, at);
          }
          if (observation.accessedViaBaseMask & observation.unknownAccessMask & observation.modifiedMask) {
            failure('RESTRICT_PROVENANCE_UNKNOWN', 'An overlapping modified access has pointer provenance that cannot be resolved for restrict.', at);
          }
        }
      }
    };
    function observeRestrictAddress(
      pointer: { readonly allocationId: number; readonly byteOffset: number },
      bases: Iterable<number> | undefined,
      unknownBases: Iterable<number> | undefined,
      byteCount: number,
      write: boolean,
      at: Location,
    ): void {
      observeRestrictRange(pointer.allocationId, pointer.byteOffset, byteCount, bases, unknownBases, write, at);
    }
    const observeRestrictAccess = (
      reference: ObjectReference,
      addressBases: Iterable<number> | undefined,
      unknownAddressBases: Iterable<number> | undefined,
      write: boolean,
      at: Location,
    ): void => {
      const view = memory.describeObjectView(reference, at);
      observeRestrictRange(
        view.allocationId, reference.byteOffset, view.size, addressBases, unknownAddressBases, write, at, view.bitMask,
      );
    };

  return {
    registerRestrictPointer, relatedRestrictBases, observeRestrictRange,
    observeRestrictAddress, observeRestrictAccess,
  };
}
