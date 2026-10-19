import { failure } from '../internal.ts';
import type { CType, CValue, Location, ObjectPointerValue } from '../internal.ts';
import { dispatchLibraryBuiltin } from '../library.ts';
import type { LibraryBuiltinResult, ResumableLibraryBuiltin } from '../library.ts';
import { callBuiltin, promote } from '../numeric.ts';
import {
  isAggregate, isArray, isFunction, isInteger, isPointer, pointedToType, pointerTo, sameType, unqualifiedType,
} from '../type-system.ts';
import type { CompiledFunction } from '../bytecode.ts';
import type { LibraryBuiltinRequest } from '../library-requests.ts';
import type { Evaluation, Frame, VaCursor } from './runtime-types.ts';
import type { LibraryRuntime, LibraryRuntimeContext } from './library-runtime-context.ts';

export function isBuiltinContinuation(value: LibraryBuiltinResult): value is ResumableLibraryBuiltin {
  return typeof value === 'object' && value !== null && typeof (value as ResumableLibraryBuiltin).next === 'function';
}

export function createLibraryRuntime(context: LibraryRuntimeContext): LibraryRuntime {
  function cursorFromHandle(handle: CValue, at: Location, allowIndeterminate = false): { id: number; cursor: VaCursor } {
    const id = context.markerId(handle);
    const cursor = id === undefined ? undefined : context.vaCursors.get(id);
    if (!cursor?.active || cursor.frame.returned || !cursor.frame.vaCursorIds.has(id!)) {
      failure('INVALID_VA_LIST', 'The argument list is inactive or its function has returned.', at);
    }
    if (cursor.indeterminate && !allowIndeterminate) {
      failure('INVALID_VA_LIST', 'The va_list became indeterminate after a v* function.', at);
    }
    context.memory.assertAlive(handle, at);
    return { id: id!, cursor };
  }

  function storeVaCursor(destination: CValue, owner: Frame, args: readonly CValue[], index: number, at: Location): void {
    if (!isPointer(destination.type) || destination.value === null) failure('INVALID_VA_LIST', 'The va_list operation requires the address of a list.', at);
    const target = context.memory.dereference(destination, at);
    if (!isPointer(target.type) || unqualifiedType(pointedToType(target.type) ?? 'void') !== 'void') failure('INVALID_VA_LIST', 'The destination does not have va_list type.', at);
    const marker = context.memory.allocate('char', 'automatic', at);
    const value = context.memory.addressOf(marker, pointerTo('char'));
    const handle = context.valueForType(value, pointerTo('void'), at);
    context.memory.write(target, handle, at);
    const cursor: VaCursor = { frame: owner, args, index, active: true, indeterminate: false, marker };
    const id = marker.allocationId;
    context.vaCursors.set(id, cursor);
    owner.vaCursorIds.add(id);
    owner.temporaryObjects.push(marker);
  }

  function endVaCursor(id: number, cursor: VaCursor, at: Location): void {
    cursor.active = false;
    context.vaCursors.delete(id);
    cursor.frame.vaCursorIds.delete(id);
    const index = cursor.frame.temporaryObjects.indexOf(cursor.marker);
    if (index >= 0) cursor.frame.temporaryObjects.splice(index, 1);
    context.memory.release(cursor.marker, at);
  }

  function invokeBuiltin(
    name: string, args: CValue[], resultType: CType | undefined, at: Location, frame: Frame,
  ): LibraryBuiltinResult {
    context.runtimeLocation = at;
    context.io!.setLocation(at);
    const { memory, libraryContext } = context;
    if (name === '__builtin_va_start') {
      if (args.length !== 2) failure('ARGUMENT_COUNT', 'va_start requires the list address and the last named parameter.', at);
      if (!frame.compiled.fn.variadic || !frame.compiled.fn.parameters.length) failure('INVALID_VA_START', 'va_start requires a variadic function with at least one named parameter.', at);
      const last = memory.dereference(args[1], at);
      const lastParameter = frame.compiled.fn.parameters.at(-1)!;
      const expected = frame.cells.get(lastParameter.binding!)?.reference;
      if (!expected || expected.objectId !== last.objectId) failure('INVALID_VA_START', 'The second argument to va_start must designate the last named parameter.', at);
      const target = memory.dereference(args[0], at);
      if (!isPointer(target.type) || unqualifiedType(pointedToType(target.type) ?? 'void') !== 'void') failure('INVALID_VA_LIST', 'The first va_start argument is not a va_list.', at);
      storeVaCursor(args[0], frame, frame.variadicArgs, 0, at);
      return { type: 'void', value: 0n };
    }
    if (name === '__builtin_va_copy') {
      if (args.length !== 2) failure('ARGUMENT_COUNT', 'va_copy requires a destination and a source.', at);
      const source = cursorFromHandle(args[1], at).cursor;
      storeVaCursor(args[0], frame, source.args, source.index, at);
      return { type: 'void', value: 0n };
    }
    if (name === '__builtin_va_end') {
      if (args.length !== 1) failure('ARGUMENT_COUNT', 'va_end requires the address of the list.', at);
      const target = memory.dereference(args[0], at);
      const handle = memory.read(target, at);
      const { id, cursor } = cursorFromHandle(handle, at, true);
      endVaCursor(id, cursor, at);
      memory.write(target, { type: target.type, value: null }, at);
      return { type: 'void', value: 0n };
    }
    const library = dispatchLibraryBuiltin(name, args, resultType, libraryContext);
    if (library) {
      if (!isBuiltinContinuation(library) && isInteger(library.type) &&
          ['atoi', 'atol', 'atoll', 'strtol', 'strtoul', 'strtoll', 'strtoull', 'strtoimax', 'strtoumax'].includes(name)) {
        const origins = context.integerPointerOrigins(library);
        if (!context.hasIntegerPointerOrigins(origins)) {
          context.rememberIntegerPointerBases(library, [], context.activeRestrictBases.keys());
        }
      }
      return library;
    }
    if (name === 'malloc') {
      if (args.length !== 1) failure('ARGUMENT_COUNT', 'malloc requires one argument.', at);
      const amount = args[0].value;
      if (typeof amount !== 'bigint' || amount < 0n) failure('INVALID_ALLOCATION_SIZE', 'malloc requires a nonnegative integer size.', at);
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) failure('TYPE_SIZE_RANGE', 'malloc size exceeds the representable range.', at);
      const pointer = context.allocateDebugHeap(Number(amount), at);
      return { type: resultType && isPointer(resultType) ? resultType : pointerTo('void'), value: pointer };
    }
    if (name === 'realloc') {
      if (args.length !== 2) failure('ARGUMENT_COUNT', 'realloc requires two arguments.', at);
      const source = context.valueForType(args[0], pointerTo('void'), at);
      const amount = args[1].value;
      if (typeof amount !== 'bigint' || amount < 0n) failure('INVALID_ALLOCATION_SIZE', 'realloc requires a nonnegative integer size.', at);
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) failure('TYPE_SIZE_RANGE', 'realloc size exceeds the representable range.', at);
      const pointer = context.reallocateDebugHeap(source.value as ObjectPointerValue | null, Number(amount), at);
      return { type: resultType && isPointer(resultType) ? resultType : pointerTo('void'), value: pointer };
    }
    if (name === 'free') {
      if (args.length !== 1) failure('ARGUMENT_COUNT', 'free requires one argument.', at);
      const pointer = context.valueForType(args[0], pointerTo('void'), at);
      const objectPointer = pointer.value as ObjectPointerValue | null;
      const debugEvents = context.debugEvents;
      const debugObjects = context.debugObjects;
      const shouldTraceDelete = !!debugEvents && !!debugObjects && memory.canFree(objectPointer) &&
        debugObjects.has(objectPointer!.allocationId);
      const reference = shouldTraceDelete ? memory.rootReference(objectPointer!.allocationId) : undefined;
      if (shouldTraceDelete) debugEvents!.reserve(at);
      try {
        memory.free(objectPointer, at);
      } catch (error) {
        if (shouldTraceDelete) debugEvents!.cancel();
        throw error;
      }
      if (shouldTraceDelete && reference) context.commitDebugObjectDelete(reference, at, null, null);
      return { type: 'void', value: 0n };
    }
    return callBuiltin(name, args, at, {
      writeOutput: (index, value) => {
        const pointer = args[index];
        if (!pointer) failure('ENGINE_INTERNAL_ERROR', `Math builtin «${name}» requested a missing output argument.`, at);
        libraryContext.writeScalar(pointer, value, at);
      },
      setErrno: (value) => libraryContext.errno.set(value),
    });
  }

  function defaultArgumentPromotion(value: CValue, at: Location): CValue {
    if (unqualifiedType(value.type) === 'float') return context.valueForType(value, 'double', at);
    if (isInteger(value.type)) {
      const promoted = promote(value.type);
      return sameType(promoted, value.type) ? value : context.valueForType(value, promoted, at);
    }
    return value;
  }

  function callbackTarget(callee: CValue, label: string, at: Location): CompiledFunction {
    if (!isPointer(callee.type) || !isFunction(pointedToType(callee.type) ?? 'void') ||
        typeof callee.value !== 'object' || callee.value === null || callee.value.kind !== 'function-pointer' ||
        callee.value.functionIndex === null) {
      failure('INVALID_LIBRARY_CALLBACK', `${label} requires an executable C function pointer.`, at);
    }
    const target = context.functions[callee.value.functionIndex];
    if (!target?.fn.body) failure('UNDEFINED_FUNCTION', `${label} points to a function without an executable definition.`, at);
    return target;
  }

  function scheduleTerminationHandler(at: Location): void {
    const termination = context.termination;
    if (!termination || termination.completed) return;
    const handler = termination.pending.pop();
    if (!handler) {
      if (termination.mode === 'normal') context.io?.flushAllOutputStreams(at);
      termination.completed = true;
      return;
    }
    const target = callbackTarget(handler, 'The termination handler', at);
    if (target.fn.parameters.length !== 0 || unqualifiedType(target.fn.returnType) !== 'void') {
      failure('INVALID_TERMINATION_HANDLER', 'The handler must have a type compatible with void(void).', target.fn.location);
    }
    context.work.push(() => {
      const result = context.operands.pop();
      if (!result) failure('ENGINE_STACK_ERROR', 'The termination handler did not produce a result.', at);
      scheduleTerminationHandler(at);
    });
    context.invoke(target, [], at, false);
  }

  function startTermination(mode: 'normal' | 'quick' | 'immediate' | 'abort', status: bigint, at: Location): void {
    const skipsHandlers = mode === 'immediate' || mode === 'abort';
    const termination = context.termination;
    if (termination && !termination.completed && !skipsHandlers) {
      failure('INVALID_TERMINATION', 'Cannot start exit or quick_exit while termination handlers are running.', at);
    }
    context.work.length = 0;
    context.operands.length = 0;
    context.awaitingInput = false;
    context.debugPause = undefined;
    const pending = skipsHandlers
      ? [] : [...(mode === 'normal' ? context.normalTerminationHandlers : context.quickTerminationHandlers)];
    context.termination = { mode, status, pending, completed: skipsHandlers };
    if (!skipsHandlers) scheduleTerminationHandler(at);
  }

  function continueLibraryGenerator(
    generator: ResumableLibraryBuiltin,
    effects: Evaluation,
    at: Location,
    response?: CValue,
  ): void {
    const next = generator.next(response);
    if (next.done) {
      effects.value = next.value;
      if (isPointer(next.value.type)) {
        const pointer = typeof next.value.value === 'object' && next.value.value !== null && next.value.value.kind === 'object-pointer'
          ? next.value.value : undefined;
        effects.pointerBases = context.activePointerBases(pointer ? context.pointerValueBases.get(pointer) : undefined);
        effects.unknownPointerBases = context.activeUnknownPointerBases(pointer ? context.unknownPointerValueBases.get(pointer) : undefined);
      }
      context.operands.push(effects);
      return;
    }
    const request: LibraryBuiltinRequest = next.value;
    if (request.kind === 'input-needed') {
      context.awaitingInput = true;
      context.work.push(() => continueLibraryGenerator(generator, effects, at));
      return;
    }
    if (request.kind === 'call-user') {
      const target = callbackTarget(request.callee, 'A library routine callback', at);
      if (request.args.length < target.fn.parameters.length ||
          !target.fn.variadic && request.args.length !== target.fn.parameters.length) {
        failure('ARGUMENT_COUNT', `Callback «${target.fn.name}» received an invalid number of arguments.`, at);
      }
      const callbackArgs = request.args.map((argument, index) => {
        const parameter = target.fn.parameters[index];
        return parameter ? context.valueForType(argument, parameter.type, at) : defaultArgumentPromotion(argument, at);
      });
      const argumentBases = request.args.map((argument) =>
        typeof argument.value === 'object' && argument.value !== null && argument.value.kind === 'object-pointer'
          ? context.activePointerBases(context.pointerValueBases.get(argument.value)) : new Set<number>());
      const argumentUnknownBases = request.args.map((argument) =>
        typeof argument.value === 'object' && argument.value !== null && argument.value.kind === 'object-pointer'
          ? context.activeUnknownPointerBases(context.unknownPointerValueBases.get(argument.value)) : new Set<number>());
      context.work.push(() => {
        const callbackResult = context.operands.pop();
        if (!callbackResult) failure('ENGINE_STACK_ERROR', 'The C callback did not produce a result.', at);
        continueLibraryGenerator(generator, effects, at, callbackResult.value);
      });
      context.invoke(target, callbackArgs, at, true, argumentBases, argumentUnknownBases);
      return;
    }
    if (request.kind === 'register-termination-handler') {
      const target = callbackTarget(request.callee, 'The termination handler', at);
      if (target.fn.parameters.length !== 0 || unqualifiedType(target.fn.returnType) !== 'void') {
        failure('INVALID_TERMINATION_HANDLER', 'The handler must have a type compatible with void(void).', target.fn.location);
      }
      const handlers = request.mode === 'normal' ? context.normalTerminationHandlers : context.quickTerminationHandlers;
      const accepted = handlers.length < 32;
      if (accepted) {
        handlers.push(request.callee);
        const termination = context.termination;
        if (termination && !termination.completed && termination.mode === request.mode) {
          termination.pending.push(request.callee);
        }
      }
      continueLibraryGenerator(generator, effects, at, context.libraryContext.makeInt(accepted ? 0 : 1, 'int'));
      return;
    }
    startTermination(request.mode, request.status, at);
  }

  function defaultReturn(type: CType, at: Location): CValue {
    if (isAggregate(type)) return { type: unqualifiedType(type), value: { kind: 'aggregate-value', snapshot: { initialized: true, zeroInitialized: true } } };
    if (isArray(type) || isFunction(type) || unqualifiedType(type) === 'void') failure('MISSING_RETURN', 'The function ends without a valid return value.', at);
    return context.valueForType(context.integer(0), type, at);
  }

  return {
    cursorFromHandle,
    storeVaCursor,
    endVaCursor,
    invokeBuiltin,
    defaultArgumentPromotion,
    callbackTarget,
    scheduleTerminationHandler,
    startTermination,
    continueLibraryGenerator,
    defaultReturn,
  };
}
