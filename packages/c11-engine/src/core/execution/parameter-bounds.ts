import { failure } from '../internal.ts';
import type { ArrayCType, CType, Location, Parameter } from '../internal.ts';
import type { VirtualMemory } from '../memory.ts';
import type { DebugEventCollector } from './debug-events.ts';
import type { Cell, Frame, RuntimeScope } from './runtime-types.ts';

/** Live operations used to resolve and validate runtime parameter bounds. */
export interface ParameterBoundsRuntimeContext {
  readonly memory: VirtualMemory;
  get debugEvents(): DebugEventCollector | undefined;
  readonly localCell: (frame: Frame, binding: number, at: Location) => Cell;
  readonly evaluateVariableBounds: (
    bounds: readonly ArrayCType[],
    frame: Frame,
    at: Location,
    done: () => void,
    retainForScope?: boolean,
  ) => void;
  readonly resolveVariableType: (type: CType, frame: Frame, at: Location) => CType;
  readonly hasVariableLengthBound: (type: CType) => boolean;
  readonly isPointer: (type: CType) => boolean;
  readonly publishAutomaticBinding: (frame: Frame, scope: RuntimeScope, binding: Cell['binding'], reference: Cell['reference']) => void;
}

export interface ParameterBoundsRuntime {
  readonly evaluateParameterBounds: (frame: Frame, parameters: readonly Parameter[], index?: number) => void;
}

export function createParameterBoundsRuntime(context: ParameterBoundsRuntimeContext): ParameterBoundsRuntime {
  function evaluateParameterBounds(frame: Frame, parameters: readonly Parameter[], index = 0): void {
    if (index >= parameters.length) return;
    const parameter = parameters[index];
    const bindingId = parameter.binding;
    if (bindingId === undefined) failure('ENGINE_INTERNAL_ERROR', 'A function parameter has no runtime binding.', parameter.location);
    const target = context.localCell(frame, bindingId, parameter.location);
    context.evaluateVariableBounds(parameter.variableLengthBounds ?? [], frame, parameter.location, () => {
      const runtimeBinding = context.hasVariableLengthBound(target.binding.type)
        ? { ...target.binding, type: context.resolveVariableType(target.binding.type, frame, parameter.location) }
        : target.binding;
      const reference = runtimeBinding !== target.binding && context.isPointer(runtimeBinding.type)
        ? context.memory.retypePointer(target.reference, runtimeBinding.type, parameter.location)
        : target.reference;
      if (runtimeBinding !== target.binding) frame.cells.set(bindingId, { binding: runtimeBinding, reference });
      const owner = frame.scopes[0];
      if (context.debugEvents && owner) context.publishAutomaticBinding(frame, owner, runtimeBinding, reference);
      evaluateParameterBounds(frame, parameters, index + 1);
    });
  }

  return { evaluateParameterBounds };
}
