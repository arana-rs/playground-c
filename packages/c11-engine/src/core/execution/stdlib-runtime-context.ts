import { failure } from '../internal.ts';
import type { CValue, Location, ObjectPointerValue, ObjectReference, ProgramIR } from '../internal.ts';
import { arrayOf, isArray, isInteger, pointerTo } from '../type-system.ts';
import type { EngineMetrics, ExecutionRuntimeServices } from '../types.ts';
import type { VirtualIO } from '../virtual-io.ts';
import type { VirtualMemory } from '../memory.ts';
import { debugTypeSummary } from './debug-format.ts';
import { calendarTimeFromEpochMilliseconds, DEFAULT_CALENDAR_TIME } from '../stdlib-time-context.ts';
import type { StdlibSessionState, StdlibTimeRuntimeContext } from '../stdlib-time-context.ts';
import type { DebugObjectRuntime } from './debug-object-runtime-context.ts';
import type { IOMemoryBridge } from './io-memory-bridge.ts';
import type { LibraryRuntime } from './library-runtime-context.ts';
import type { PointerRuntime } from './pointer-runtime-context.ts';

/** Live state and helpers needed to assemble the standard-library context. */
export interface StdlibRuntimeContextFactoryContext {
  readonly ir: ProgramIR;
  readonly memory: VirtualMemory;
  readonly metrics: EngineMetrics;
  readonly stdlibState: StdlibSessionState;
  readonly runtimeServices: ExecutionRuntimeServices | undefined;
  get runtimeLocation(): Location;
  get io(): VirtualIO | undefined;
  get errnoPointer(): CValue | undefined;
  set errnoPointer(value: CValue | undefined);
  readonly allocateDebugHeap: DebugObjectRuntime['allocateDebugHeap'];
  readonly allocateDebugObject: DebugObjectRuntime['allocateDebugObject'];
  readonly ioMemoryBridge: IOMemoryBridge;
  readonly cursorFromHandle: LibraryRuntime['cursorFromHandle'];
  readonly observeRestrictAccess: (
    reference: ObjectReference,
    addressBases: Iterable<number> | undefined,
    unknownAddressBases: Iterable<number> | undefined,
    write: boolean,
    at: Location,
  ) => void;
  readonly getErrnoReference: () => ObjectReference;
  readonly integer: (value: bigint | number | boolean, type?: CValue['type']) => CValue;
  readonly valueForType: PointerRuntime['valueForType'];
  readonly rememberPointerBases: PointerRuntime['rememberPointerBases'];
  readonly pointerValueBases: WeakMap<ObjectPointerValue, Set<number>>;
  readonly unknownPointerValueBases: WeakMap<ObjectPointerValue, Set<number>>;
  readonly copyIntegerPointerOrigins: PointerRuntime['copyIntegerPointerOrigins'];
  readonly restoreIntegerPointerOrigins: PointerRuntime['restoreIntegerPointerOrigins'];
}

/** Assemble standard-library services without running them or snapshotting VM state. */
export function createStdlibRuntimeContext(
  context: StdlibRuntimeContextFactoryContext,
): StdlibTimeRuntimeContext {
  const {
    ir, memory, metrics, stdlibState, runtimeServices,
    allocateDebugHeap, allocateDebugObject, cursorFromHandle, observeRestrictAccess,
    getErrnoReference, integer, valueForType, rememberPointerBases,
    pointerValueBases, unknownPointerValueBases,
    copyIntegerPointerOrigins, restoreIntegerPointerOrigins,
  } = context;
  const {
    filePointers, filePointerValues, standardFiles, standardFileKeys,
    pointerKey, asBytePointer, readBytes, preflightMemoryWrite, writeBytes,
    readCString, copyBytes, writeScalar, chargeWork, makeFilePointer, standardFile, streamFor,
  } = context.ioMemoryBridge;

  const libraryContext: StdlibTimeRuntimeContext = {
    get at() { return context.runtimeLocation; },
    get io() { return context.io!; },
    stdlibState,
    environment: {},
    currentCalendarTime: () => runtimeServices?.wallClock
      ? calendarTimeFromEpochMilliseconds(runtimeServices.wallClock.nowEpochMilliseconds())
      : DEFAULT_CALENDAR_TIME,
    clockTicks: () => BigInt(metrics.instructionCount) * 1000n,
    allocateHeap: (size, at) => allocateDebugHeap(size, at),
    allocateHeapAligned: (size, alignment, at) => allocateDebugHeap(size, at, alignment),
    allocateStaticObject: (type, at) => {
      const reference = allocateDebugObject(() => memory.allocate(type, 'static', at), {
        duration: 'static', origin: 'variable', typeSummary: debugTypeSummary(type, ir.aggregates),
        location: at, frameId: null, scopeId: null,
      });
      memory.zeroInitialize(reference, at);
      return isArray(type) ? memory.decay(reference) : memory.addressOf(reference, pointerTo(type));
    },
    zeroHeap: (pointer, size, at) => {
      const reference = memory.rootReference(pointer.allocationId);
      if (!reference || memory.describeObjectView(reference, at).size !== size) {
        failure('INVALID_MEMORY_SIZE', 'calloc must initialize the full allocation size.', at);
      }
      memory.zeroInitialize(reference, at);
    },
    swapObjectBytes: (left, right, size, at) => {
      if (!Number.isSafeInteger(size) || size < 0) failure('INVALID_MEMORY_SIZE', 'The swap requests an unrepresentable size.', at);
      if (size === 0 || left.allocationId === right.allocationId && left.byteOffset === right.byteOffset) return;
      const leftValue: CValue = { type: pointerTo('unsigned char'), value: left };
      const rightValue: CValue = { type: pointerTo('unsigned char'), value: right };
      const snapshot = (pointer: CValue) => {
        const address = asBytePointer(pointer, at).value as ObjectPointerValue;
        return {
          bytes: readBytes(pointer, size, at),
          pointers: memory.copyablePointerValues(address, size, at),
          effectiveTypes: memory.copyableEffectiveTypes(address, size, at),
          integerOrigins: copyIntegerPointerOrigins(address.allocationId, address.byteOffset, size),
        };
      };
      const leftSnapshot = snapshot(leftValue);
      const rightSnapshot = snapshot(rightValue);
      const restore = (destination: CValue, source: ReturnType<typeof snapshot>): void => {
        const address = asBytePointer(destination, at).value as ObjectPointerValue;
        writeBytes(destination, source.bytes, at);
        memory.restoreCopiedPointerValues(address, size, source.pointers, at);
        memory.restoreCopiedEffectiveTypes(address, size, source.effectiveTypes, at);
        restoreIntegerPointerOrigins(address.allocationId, address.byteOffset, size, source.integerOrigins);
      };
      restore(leftValue, rightSnapshot);
      restore(rightValue, leftSnapshot);
    },
    readBytes,
    writeBytes,
    readCString,
    copyBytes,
    writeScalar,
    formatPointer: (value, at) => memory.formatPointer(value, at),
    parsePointer: (text, at) => memory.parsePointer(text, at),
    openFile: (path, mode, at) => {
      const stream = context.io!.open(path, mode, at);
      return stream ? makeFilePointer(stream, at) : null;
    },
    streamFor,
    standardFile,
    makeFilePointer,
    closeFilePointer: (file, at) => {
      const key = pointerKey(file);
      if (!key) return -1;
      const stream = filePointers.get(key);
      if (!stream || stream.isClosed) return -1;
      const closed = stream.close(at);
      if (!standardFileKeys.has(key)) filePointers.delete(key);
      filePointerValues.delete(stream);
      return closed ? 0 : -2;
    },
    consumeVaList: (list, at) => {
      const { cursor } = cursorFromHandle(list, at);
      if (cursor.indeterminate) failure('INVALID_VA_LIST', 'The va_list became indeterminate after a v* function.', at);
      const remaining = cursor.args.slice(cursor.index);
      cursor.index = cursor.args.length;
      cursor.indeterminate = true;
      return remaining;
    },
    reopenFilePointer: (file, path, mode, at) => {
      const key = pointerKey(file);
      if (!key) return null;
      const previous = filePointers.get(key);
      const isStandard = standardFileKeys.has(key);
      if (!previous || previous.isClosed && !isStandard) return null;
      if (!previous.isClosed) previous.close(at);
      filePointerValues.delete(previous);
      if (path === null) return null;
      const replacement = context.io!.open(path, mode, at);
      if (!replacement) {
        if (!isStandard) filePointers.delete(key);
        return null;
      }
      filePointers.set(key, replacement);
      filePointerValues.set(replacement, file);
      if (isStandard) {
        const kind = [...standardFiles].find(([, standard]) => pointerKey(standard) === key)?.[0];
        if (kind) context.io!.replaceStandardStream(kind, replacement);
      }
      return file;
    },
    errno: {
      get: () => {
        const reference = getErrnoReference();
        observeRestrictAccess(reference, undefined, undefined, false, context.runtimeLocation);
        const value = memory.read(reference, context.runtimeLocation).value;
        return typeof value === 'bigint' ? Number(value) : 0;
      },
      set: (value) => writeScalar(
        memory.addressOf(getErrnoReference(), pointerTo('int')),
        integer(BigInt(value), 'int'), context.runtimeLocation,
      ),
    },
    makeErrnoPointer: () => {
      const pointer = context.errnoPointer;
      if (pointer) return pointer;
      const created = memory.addressOf(getErrnoReference(), pointerTo('int'));
      context.errnoPointer = created;
      return created;
    },
    makeInt: (value, type) => {
      const target = typeof type === 'string' && isInteger(type) ? type : 'int';
      return valueForType(integer(value, target), target, context.runtimeLocation);
    },
    chargeWork,
    preflightOutputBytes: (count, at) => context.io!.preflightBufferBytes(count, at),
    preflightMemoryWrite,
    offsetPointer: (pointer, byteOffset, at) => {
      if (!Number.isSafeInteger(byteOffset)) failure('INVALID_POINTER_ARITHMETIC', 'The byte offset is not representable.', at);
      const bytes = asBytePointer(pointer, at);
      const original = bytes.value as ObjectPointerValue;
      const result: CValue = {
        type: pointer.type,
        value: { ...original, byteOffset: original.byteOffset + byteOffset },
      };
      rememberPointerBases(result, pointerValueBases.get(original), unknownPointerValueBases.get(original));
      return result;
    },
    makeString: (bytes, at) => {
      const reference = memory.allocate(arrayOf('char', bytes.length + 1), 'static', at);
      memory.zeroInitialize(reference, at);
      if (bytes.length) writeBytes(memory.decay(reference), bytes, at);
      return memory.decay(reference);
    },
    fail: (code, message, at) => failure(code, message, at),
  };
  return libraryContext;
}
