import { enforceLimit, failure } from '../internal.ts';
import type { CValue, Location } from '../internal.ts';
import { promote } from '../numeric.ts';
import {
  hasVariableLengthBound, isPointer, qualifiersOf, unqualifiedType, variableLengthArrayTypes,
} from '../type-system.ts';
import { debugTypeSummary } from './debug-format.ts';
import type { CompiledFunction } from '../bytecode.ts';
import type { Frame, RuntimeScope } from './runtime-types.ts';
import type { VmDispatchRuntime, VmDispatchRuntimeContext } from './vm-dispatch-context.ts';

/** Dispatch compiled instructions and calls while retaining the session's live state. */
export function createVmDispatchRuntime(context: VmDispatchRuntimeContext): VmDispatchRuntime {
  const {
    ir, memory, limits, metrics,
    debugOptions, work, operands, vaCursors, activeDebugFrames, output, sameDebugLine,
    instruction, enter, evaluateParameterBounds, leave, evaluateVariableBounds,
    resolveVariableType, initializeObject, registerRestrictPointer, jump,
    evaluateFullExpression, materialize, valueForType, activePointerBases,
    activeUnknownPointerBases, truthValue, allocateDebugObject, publishAutomaticBinding,
    hasPersistentDuration, defaultReturn, endVaCursor, plain, integer,
  } = context;

  const step = (frame: Frame): void => {
    work.push(() => {
      if (frame.returned || frame.pc >= frame.compiled.code.length) return;
      const node = frame.compiled.code[frame.pc];
      if (debugOptions !== undefined && context.debugStartPhase && frame.compiled.fn.name === 'main') {
        // Enter main's root scope before exposing the first user instruction.
        if (frame.pc === 0 && node.op === 'enter') {
          context.debugLocation = node.location;
        } else {
          context.debugStartPhase = false;
          context.debugEntryReady = true;
          context.debugLocation = node.location;
          work.push(() => step(frame));
          return;
        }
      }
      if (debugOptions !== undefined && context.debugStepActive) {
        let visited = context.debugVisitedInstructions!.get(frame);
        if (!visited) { visited = new Set(); context.debugVisitedInstructions!.set(frame, visited); }
        const repeatedVisit = visited.has(frame.pc);
        const changedLine = context.debugStepExecuted && !sameDebugLine(context.debugStepStartLocation, node.location);
        if (context.debugStepExecuted && (changedLine || repeatedVisit)) {
          context.debugLocation = node.location;
          context.debugPause = {
            kind: 'paused',
            location: Object.freeze({ file: node.location.file, line: node.location.line, column: node.location.column }),
            metrics,
            ...output(),
          };
          work.push(() => step(frame));
          return;
        }
        visited.add(frame.pc);
        context.debugStepExecuted = true;
        context.debugLocation = node.location;
      }
      frame.pc++;
      instruction(node.location);
      work.push(() => step(frame));
      if (node.op === 'enter') enter(frame, node.scope);
      else if (node.op === 'parameterBounds') evaluateParameterBounds(frame, node.parameters);
      else if (node.op === 'leave') leave(frame);
      else if (node.op === 'typeDeclaration') {
        evaluateVariableBounds(variableLengthArrayTypes(node.type), frame, node.location, () => {});
      }
      else if (node.op === 'declaration') {
        const binding = frame.compiled.fn.bindings[node.binding];
        if (!binding) failure('ENGINE_INTERNAL_ERROR', 'The declaration has no function binding.', node.location);
        evaluateVariableBounds(variableLengthArrayTypes(binding.type), frame, node.location, () => {
          const resolvedType = resolveVariableType(binding.type, frame, node.location);
          let target = frame.cells.get(node.binding);
          let ownerScope: RuntimeScope | undefined;
          for (let index = frame.scopes.length - 1; index >= 0; index--) {
            if (frame.scopes[index].layout.bindings.some((candidate) => candidate.id === node.binding)) {
              ownerScope = frame.scopes[index];
              break;
            }
          }
          if (!ownerScope) failure('INACTIVE_OBJECT', 'The declaration does not belong to an active scope.', node.location);
          if (target) {
            if (hasVariableLengthBound(binding.type)) {
              const reference = isPointer(resolvedType)
                ? memory.retypePointer(target.reference, resolvedType, node.location)
                : target.reference;
              target = { binding: { ...target.binding, type: resolvedType }, reference };
              frame.cells.set(node.binding, target);
            }
          } else {
            const options = {
              isConst: binding.isConst === true || qualifiersOf(resolvedType).const || binding.qualifiers?.const === true,
              ...(binding.alignment === undefined ? {} : { alignment: binding.alignment }),
            };
            const allocate = () => memory.allocate(resolvedType, 'automatic', binding.location, options);
            const reference = context.debugEvents
              ? allocateDebugObject(allocate, {
                duration: 'automatic', origin: 'variable', typeSummary: debugTypeSummary(resolvedType, ir.aggregates),
                location: binding.location, frameId: frame.frameId, scopeId: ownerScope.scopeId,
                name: binding.name, readOnly: options.isConst,
              })
              : allocate();
            target = { binding: { ...binding, type: resolvedType }, reference };
            frame.cells.set(node.binding, target);
            ownerScope.cells.push(node.binding);
            registerRestrictPointer(ownerScope, target.binding, reference);
          }
          if (context.debugEvents && !hasPersistentDuration(target.binding)) {
            publishAutomaticBinding(frame, ownerScope, target.binding, target.reference);
          }
          if (node.initializer && (!hasPersistentDuration(target.binding) || !context.initializedStaticBindings.has(target.binding))) {
            if (hasPersistentDuration(target.binding)) context.initializedStaticBindings.add(target.binding);
            initializeObject(target.reference, target.binding.type, node.initializer, frame);
          }
        });
      } else if (node.op === 'expression') {
        evaluateFullExpression(node.value, frame, () => {
          const result = operands.pop();
          if (result) materialize(result, node.location);
        }, 1, false);
      } else if (node.op === 'return') {
        if (context.debugEvents) frame.returnLocation = node.location;
        const consume = () => {
          const result = node.value ? operands.pop() : undefined;
          const value = result ? valueForType(materialize(result, node.location), frame.compiled.fn.returnType, node.location)
            : { type: 'void', value: 0n } as CValue;
          frame.result = value;
          frame.resultPointerBases = result && isPointer(value.type)
            ? activePointerBases(result.pointerBases) : undefined;
          frame.resultUnknownPointerBases = result && isPointer(value.type)
            ? activeUnknownPointerBases(result.unknownPointerBases) : undefined;
          frame.returned = true;
        };
        if (node.value) evaluateFullExpression(node.value, frame, consume);
        else work.push(consume);
      } else if (node.op === 'jump') {
        jump(frame, node.target, node.vmScopeExit, node.vmScopeTarget, node.location);
      }
      else if (node.op === 'branch') {
        evaluateFullExpression(node.condition, frame, () => {
          const result = operands.pop();
          if (!result || !truthValue(materialize(result, node.location))) jump(frame, node.target);
        });
      } else if (node.op === 'switch') {
        evaluateFullExpression(node.value, frame, () => {
          const result = operands.pop();
          if (!result) failure('ENGINE_STACK_ERROR', 'Missing switch value.', node.location);
          const value = valueForType(materialize(result, node.location), promote(node.value.type!), node.location);
          const match = node.cases.find((item) => valueForType(item.value, value.type, node.location).value === value.value);
          jump(frame, match?.target ?? node.target);
        });
      }
    });
  };

  function invoke(
    compiled: CompiledFunction,
    args: CValue[],
    at: Location,
    used = true,
    argumentPointerBases?: readonly ReadonlySet<number>[],
    argumentUnknownPointerBases?: readonly ReadonlySet<number>[],
  ): void {
    if (!compiled?.fn.body) failure('UNDEFINED_FUNCTION', 'The called function has no definition in this file.', at);
    const parameterCount = compiled.fn.parameters.length;
    if (args.length < parameterCount || !compiled.fn.variadic && args.length !== parameterCount) {
      failure('ARGUMENT_COUNT', 'Function «' + compiled.fn.name + '» requires ' + compiled.fn.parameters.length + ' arguments.', at);
    }
    enforceLimit('maxDepth', context.callDepth + 1, limits.maxDepth, at);
    const frameId = context.debugEvents ? context.nextDebugFrameId++ : null;
    context.debugEvents?.reserve(compiled.fn.location);
    context.callDepth++;
    const frame: Frame = {
      compiled, frameId, args, variadicArgs: args.slice(parameterCount), vaCursorIds: new Set(), temporaryObjects: [],
      ...(argumentPointerBases === undefined ? {} : { argumentPointerBases }),
      ...(argumentUnknownPointerBases === undefined ? {} : { argumentUnknownPointerBases }),
      pc: 0, cells: new Map(), vlaLengths: new Map(), scopes: [], returned: false,
    };
    activeDebugFrames?.push(frame);
    context.debugEvents?.commit({
      kind: 'frame-enter', location: compiled.fn.location,
      frameId, scopeId: null, functionName: compiled.fn.name,
    });
    work.push(() => {
      const exitLocation = context.debugEvents
        ? frame.returnLocation ?? frame.compiled.fn.body?.endLocation ?? context.runtimeLocation
        : context.runtimeLocation;
      let reservedFrameExit = false;
      if (context.debugEvents) {
        context.debugEvents.reserve(exitLocation);
        reservedFrameExit = true;
      }
      try {
        while (frame.scopes.length) leave(frame, exitLocation);
        for (const id of [...frame.vaCursorIds]) {
          const cursor = vaCursors.get(id);
          if (cursor) endVaCursor(id, cursor, at);
        }
        frame.returned = true;
        context.callDepth--;
        activeDebugFrames?.pop();
        if (reservedFrameExit) {
          context.debugEvents!.commit({
            kind: 'frame-exit', location: exitLocation,
            frameId, scopeId: null, functionName: compiled.fn.name,
          });
          reservedFrameExit = false;
        }
      } catch (error) {
        if (reservedFrameExit) context.debugEvents!.cancel();
        throw error;
      }
      if (compiled.fn.noreturn) failure('NORETURN_RETURN', `Function «${compiled.fn.name}» was declared _Noreturn but returned.`, compiled.fn.location);
      let value = frame.result;
      if (!value) {
        if (compiled.fn.name === 'main') value = integer(0);
        else if (unqualifiedType(compiled.fn.returnType) === 'void') value = { type: 'void', value: 0n };
        else if (!used) value = defaultReturn(compiled.fn.returnType, at);
        else failure('MISSING_RETURN', 'Function «' + compiled.fn.name + '» ends without returning a value.', compiled.fn.location);
      }
      const result = plain(value);
      if (isPointer(value.type)) {
        result.pointerBases = activePointerBases(frame.resultPointerBases);
        result.unknownPointerBases = activeUnknownPointerBases(frame.resultUnknownPointerBases);
      }
      operands.push(result);
    });
    step(frame);
  }

  return { step, invoke };
}
