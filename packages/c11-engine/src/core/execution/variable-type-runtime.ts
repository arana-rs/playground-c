import { failure } from '../internal.ts';
import type { ArrayCType, CType, Location, ProgramIR } from '../internal.ts';
import { arrayOf, functionOf, isInteger, pointerTo, qualifyType, sizeOfType } from '../type-system.ts';
import type { VirtualMemory } from '../memory.ts';
import type { Evaluation, Frame } from './runtime-types.ts';
import type { EffectsRuntime } from './effects-runtime.ts';

/** Shared live VM state and callbacks for runtime variable-length type handling. */
export interface VariableTypeRuntimeContext {
  readonly ir: ProgramIR;
  readonly memory: VirtualMemory;
  readonly work: Array<() => void>;
  readonly operands: Evaluation[];
  get runtimeLocation(): Location;
  readonly evaluateFullExpression: EffectsRuntime['evaluateFullExpression'];
  readonly materialize: EffectsRuntime['materialize'];
}

export interface VariableTypeRuntime {
  readonly resolveVariableType: (type: CType, frame: Frame, at: Location) => CType;
  readonly evaluateVariableBounds: (
    bounds: readonly ArrayCType[],
    frame: Frame,
    at: Location,
    done: () => void,
    retainForScope?: boolean,
  ) => void;
}

export function createVariableTypeRuntime(context: VariableTypeRuntimeContext): VariableTypeRuntime {
  function resolveVariableType(type: CType, frame: Frame, at: Location): CType {
    if (typeof type === 'string') return type;
    if (type.kind === 'qualified') return qualifyType(resolveVariableType(type.base, frame, at), type.qualifiers);
    if (type.kind === 'array') {
      const length = type.lengthExpression ? frame.vlaLengths.get(type) : type.length;
      if (type.lengthExpression && length === undefined) {
        failure('UNRESOLVED_VLA_SIZE', 'The variable-length array bound has not been evaluated in this scope.', at);
      }
      return arrayOf(resolveVariableType(type.element, frame, at), length ?? null);
    }
    if (type.kind === 'pointer') return pointerTo(resolveVariableType(type.base, frame, at), {
      ...(type.const === undefined ? {} : { const: type.const }),
      ...(type.volatile === undefined ? {} : { volatile: type.volatile }),
      ...(type.restrict === undefined ? {} : { restrict: type.restrict }),
      ...(type.baseConst === undefined ? {} : { baseConst: type.baseConst }),
      ...(type.baseVolatile === undefined ? {} : { baseVolatile: type.baseVolatile }),
    });
    if (type.kind === 'function') return functionOf(
      resolveVariableType(type.returnType, frame, at),
      type.parameters.map((parameter) => resolveVariableType(parameter, frame, at)),
      !!type.variadic,
      type.prototype !== false,
    );
    return type;
  }

  function evaluateVariableBounds(
    bounds: readonly ArrayCType[],
    frame: Frame,
    at: Location,
    done: () => void,
    retainForScope = true,
  ): void {
    const ephemeralTypes: ArrayCType[] = [];
    const evaluateAt = (index: number): void => {
      while (index < bounds.length && (!bounds[index].lengthExpression || frame.vlaLengths.has(bounds[index]))) index++;
      if (index >= bounds.length) {
        for (const array of bounds) {
          if (array.lengthExpression) sizeOfType(resolveVariableType(array, frame, at), context.ir.aggregates, array.lengthExpression.location);
        }
        try { done(); }
        finally {
          for (const type of ephemeralTypes) frame.vlaLengths.delete(type);
        }
        return;
      }
      const array = bounds[index];
      const expression = array.lengthExpression!;
      context.evaluateFullExpression(expression, frame, () => {
        const result = context.operands.pop();
        if (!result) failure('ENGINE_STACK_ERROR', 'Missing variable-length array bound value.', expression.location);
        const value = context.materialize(result, expression.location);
        if (!isInteger(value.type) || typeof value.value !== 'bigint') {
          failure('TYPE_ERROR', 'A variable-length array bound must have integer type.', expression.location);
        }
        if (value.value <= 0n) failure('INVALID_ARRAY_BOUND', 'A variable-length array bound must be greater than zero.', expression.location);
        if (value.value > BigInt(Number.MAX_SAFE_INTEGER)) failure('TYPE_SIZE_RANGE', 'The variable-length array bound exceeds the representable range.', expression.location);
        const owner = frame.scopes.at(-1);
        if (!owner) failure('INVALID_SCOPE', 'A variable-length array bound requires an active block scope.', at);
        frame.vlaLengths.set(array, Number(value.value));
        if (retainForScope) {
          if (!owner.vlaTypeKeys.includes(array)) owner.vlaTypeKeys.push(array);
        } else ephemeralTypes.push(array);
        evaluateAt(index + 1);
      });
    };
    evaluateAt(0);
  }

  return { resolveVariableType, evaluateVariableBounds };
}
