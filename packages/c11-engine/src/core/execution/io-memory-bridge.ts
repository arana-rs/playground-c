import type { EngineMetrics, ExecuteLimits } from '../types.ts';
import type {
  CValue, Location, ObjectPointerValue, ObjectReference,
} from '../internal.ts';
import { isInteger, isPointer, pointerTo } from '../type-system.ts';
import type { VirtualMemory } from '../memory.ts';
import type { VirtualIO, VirtualStream } from '../virtual-io.ts';

export type IntegerPointerOriginSnapshot = readonly {
  relativeOffset: number;
  size: number;
  known: Set<number>;
  unknown: Set<number>;
}[];

/** Live execution state and callbacks needed by memory and virtual stdio helpers. */
export interface IOMemoryBridgeContext {
  readonly memory: VirtualMemory;
  readonly metrics: EngineMetrics;
  readonly pointerValueBases: WeakMap<ObjectPointerValue, Set<number>>;
  readonly unknownPointerValueBases: WeakMap<ObjectPointerValue, Set<number>>;
  readonly integerValueBases: WeakMap<CValue, Set<number>>;
  readonly unknownIntegerValueBases: WeakMap<CValue, Set<number>>;
  get runtimeLocation(): Location;
  get io(): VirtualIO | undefined;
  get limits(): Pick<ExecuteLimits, 'maxInstructions'>;
  readonly failure: typeof import('../internal.ts').failure;
  readonly enforceLimit: typeof import('../internal.ts').enforceLimit;
  readonly observeRestrictAddress: (
    pointer: ObjectPointerValue,
    bases: Iterable<number> | undefined,
    unknownBases: Iterable<number> | undefined,
    byteCount: number,
    write: boolean,
    at: Location,
  ) => void;
  readonly observeRestrictAccess: (
    reference: ObjectReference,
    addressBases: Iterable<number> | undefined,
    unknownAddressBases: Iterable<number> | undefined,
    write: boolean,
    at: Location,
  ) => void;
  readonly clearIntegerPointerOriginsInRange: (allocationId: number, byteOffset: number, byteCount: number) => void;
  readonly copyIntegerPointerOrigins: (
    allocationId: number,
    byteOffset: number,
    byteCount: number,
  ) => IntegerPointerOriginSnapshot;
  readonly restoreIntegerPointerOrigins: (
    allocationId: number,
    byteOffset: number,
    byteCount: number,
    copied: IntegerPointerOriginSnapshot,
  ) => void;
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
}

export interface IOMemoryBridge {
  readonly filePointers: Map<string, VirtualStream>;
  readonly filePointerValues: Map<VirtualStream, CValue>;
  readonly standardFiles: Map<'stdin' | 'stdout' | 'stderr', CValue>;
  readonly standardFileKeys: Set<string>;
  readonly pointerKey: typeof pointerKey;
  readonly asBytePointer: (pointer: CValue, at: Location) => CValue;
  readonly readBytes: (pointer: CValue, count: number, at: Location) => Uint8Array;
  readonly preflightMemoryWrite: (pointer: CValue, count: number, at: Location) => void;
  readonly writeBytes: (pointer: CValue, bytes: Uint8Array, at: Location) => void;
  readonly readCString: (pointer: CValue, at: Location, maxBytes?: number) => Uint8Array;
  readonly copyBytes: (destination: CValue, source: CValue, count: number, at: Location) => void;
  readonly writeScalar: (pointer: CValue, value: CValue, at: Location) => void;
  readonly chargeWork: (count: number, at: Location) => void;
  readonly makeFilePointer: (stream: VirtualStream, at: Location) => CValue;
  readonly standardFile: (kind: 'stdin' | 'stdout' | 'stderr', at: Location) => CValue;
  readonly streamFor: (file: CValue, at: Location) => VirtualStream | null;
}

export const pointerKey = (value: CValue): string | undefined => {
  if (typeof value.value !== 'object' || value.value === null || value.value.kind !== 'object-pointer') return undefined;
  return `${value.value.allocationId}:${value.value.byteOffset}`;
};

export function createIOMemoryBridge(context: IOMemoryBridgeContext): IOMemoryBridge {
  const filePointers = new Map<string, VirtualStream>();
  const filePointerValues = new Map<VirtualStream, CValue>();
  const standardFiles = new Map<'stdin' | 'stdout' | 'stderr', CValue>();
  const standardFileKeys = new Set<string>();

  const asBytePointer = (pointer: CValue, at: Location): CValue => {
    if (!isPointer(pointer.type) || pointer.value === null || typeof pointer.value !== 'object' || pointer.value.kind !== 'object-pointer') {
      context.failure('INVALID_POINTER_ACCESS', 'The memory operation requires a non-null object pointer.', at);
    }
    return { type: pointerTo('unsigned char'), value: pointer.value };
  };
  const readBytes = (pointer: CValue, count: number, at: Location): Uint8Array => {
    if (!Number.isSafeInteger(count) || count < 0) context.failure('INVALID_MEMORY_SIZE', 'The read requests an unrepresentable number of bytes.', at);
    if (count === 0) return new Uint8Array();
    const bytePointer = asBytePointer(pointer, at);
    const address = bytePointer.value as ObjectPointerValue;
    if (count > address.boundsEnd - address.byteOffset) context.failure('POINTER_BOUNDS', 'Read exceeds the pointed-to object.', at);
    context.observeRestrictAddress(
      address, context.pointerValueBases.get(address), context.unknownPointerValueBases.get(address), count, false, at,
    );
    const bytes = new Uint8Array(count);
    for (let index = 0; index < count; index++) {
      const current = { ...address, byteOffset: address.byteOffset + index };
      const ref = context.memory.dereference({ type: bytePointer.type, value: current }, at);
      const value = context.memory.read(ref, at).value;
      if (typeof value !== 'bigint') context.failure('INVALID_OBJECT_REPRESENTATION', 'The read byte has no integer representation.', at);
      bytes[index] = Number(BigInt.asUintN(8, value));
    }
    return bytes;
  };
  const preflightMemoryWrite = (pointer: CValue, count: number, at: Location): void => {
    if (!Number.isSafeInteger(count) || count < 0) context.failure('INVALID_MEMORY_SIZE', 'The write requests an unrepresentable number of bytes.', at);
    if (count === 0) return;
    const bytePointer = asBytePointer(pointer, at);
    const address = bytePointer.value as ObjectPointerValue;
    if (count > address.boundsEnd - address.byteOffset) context.failure('POINTER_BOUNDS', 'Write exceeds the pointed-to object.', at);
    for (let index = 0; index < count; index++) {
      const current = { ...address, byteOffset: address.byteOffset + index };
      context.memory.dereference({ type: bytePointer.type, value: current }, at);
    }
  };
  const writeBytes = (pointer: CValue, bytes: Uint8Array, at: Location): void => {
    preflightMemoryWrite(pointer, bytes.length, at);
    if (!bytes.length) return;
    const bytePointer = asBytePointer(pointer, at);
    const address = bytePointer.value as ObjectPointerValue;
    context.observeRestrictAddress(
      address, context.pointerValueBases.get(address), context.unknownPointerValueBases.get(address), bytes.length, true, at,
    );
    context.clearIntegerPointerOriginsInRange(address.allocationId, address.byteOffset, bytes.length);
    for (let index = 0; index < bytes.length; index++) {
      const current = { ...address, byteOffset: address.byteOffset + index };
      const ref = context.memory.dereference({ type: bytePointer.type, value: current }, at);
      context.memory.write(ref, { type: 'unsigned char', value: BigInt(bytes[index]) }, at);
    }
  };
  const readCString = (pointer: CValue, at: Location, maxBytes?: number): Uint8Array => {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      context.failure('INVALID_MEMORY_SIZE', 'The string read limit is not representable.', at);
    }
    if (maxBytes === 0) return new Uint8Array();
    const bytePointer = asBytePointer(pointer, at);
    const address = bytePointer.value as ObjectPointerValue;
    if (address.byteOffset < address.boundsStart || address.byteOffset >= address.boundsEnd) {
      context.failure('POINTER_BOUNDS', 'The string starts outside the pointed-to object.', at);
    }
    const bytes: number[] = [];
    const limit = maxBytes === undefined ? address.boundsEnd : Math.min(address.boundsEnd, address.byteOffset + maxBytes);
    for (let offset = address.byteOffset; offset < limit; offset++) {
      const current = { ...address, byteOffset: offset };
      context.observeRestrictAddress(
        current, context.pointerValueBases.get(address), context.unknownPointerValueBases.get(address), 1, false, at,
      );
      const ref = context.memory.dereference({ type: bytePointer.type, value: current }, at);
      const value = context.memory.read(ref, at).value;
      if (typeof value !== 'bigint') context.failure('INVALID_OBJECT_REPRESENTATION', 'A string byte is not an integer.', at);
      const byte = Number(BigInt.asUintN(8, value));
      if (byte === 0) return Uint8Array.from(bytes);
      bytes.push(byte);
    }
    if (maxBytes !== undefined && bytes.length === maxBytes) return Uint8Array.from(bytes);
    context.failure('UNTERMINATED_STRING', 'The string contains no NUL within the pointed-to object.', at);
  };
  const copyBytes = (destination: CValue, source: CValue, count: number, at: Location): void => {
    if (count === 0) {
      writeBytes(destination, readBytes(source, count, at), at);
      return;
    }
    const bytes = readBytes(source, count, at);
    const sourceAddress = asBytePointer(source, at).value as ObjectPointerValue;
    const integerOrigins = context.copyIntegerPointerOrigins(sourceAddress.allocationId, sourceAddress.byteOffset, count);
    const pointerValues = context.memory.copyablePointerValues(sourceAddress, count, at);
    const effectiveTypes = context.memory.copyableEffectiveTypes(sourceAddress, count, at);
    const destinationAddress = asBytePointer(destination, at).value as ObjectPointerValue;
    writeBytes(destination, bytes, at);
    context.memory.restoreCopiedPointerValues(destinationAddress, count, pointerValues, at);
    context.memory.restoreCopiedEffectiveTypes(destinationAddress, count, effectiveTypes, at);
    context.restoreIntegerPointerOrigins(destinationAddress.allocationId, destinationAddress.byteOffset, count, integerOrigins);
  };
  const writeScalar = (pointer: CValue, value: CValue, at: Location): void => {
    const reference = context.memory.dereference(pointer, at);
    if (pointer.value !== null && typeof pointer.value === 'object' && pointer.value.kind === 'object-pointer') {
      context.observeRestrictAccess(
        reference, context.pointerValueBases.get(pointer.value), context.unknownPointerValueBases.get(pointer.value), true, at,
      );
    }
    const converted = context.valueForType(value, reference.type, at);
    const pointerBases = isPointer(reference.type) && typeof converted.value === 'object' && converted.value !== null && converted.value.kind === 'object-pointer'
      ? context.pointerValueBases.get(converted.value) : undefined;
    const unknownPointerBases = isPointer(reference.type) && typeof converted.value === 'object' && converted.value !== null && converted.value.kind === 'object-pointer'
      ? context.unknownPointerValueBases.get(converted.value) : undefined;
    const integerBases = isInteger(reference.type) ? context.integerValueBases.get(converted) : undefined;
    const unknownIntegerBases = isInteger(reference.type) ? context.unknownIntegerValueBases.get(converted) : undefined;
    const view = context.memory.describeObjectView(reference, at);
    context.clearIntegerPointerOriginsInRange(view.allocationId, reference.byteOffset, view.size);
    context.memory.write(reference, converted, at);
    if (isPointer(reference.type)) context.setPointerBasesForObject(reference, pointerBases, unknownPointerBases);
    if (isInteger(reference.type)) context.setIntegerPointerBasesForObject(reference, integerBases, unknownIntegerBases);
  };
  const chargeWork = (count: number, at: Location): void => {
    if (!Number.isSafeInteger(count) || count < 0) context.failure('INVALID_WORK_SIZE', 'The requested work amount is not representable.', at);
    context.metrics.instructionCount += count;
    context.enforceLimit('maxInstructions', context.metrics.instructionCount, context.limits.maxInstructions, at);
  };
  const makeFilePointer = (stream: VirtualStream, at: Location): CValue => {
    const known = filePointerValues.get(stream);
    if (known) return known;
    const marker = context.memory.allocate('char', 'static', at);
    const value = context.memory.addressOf(marker, pointerTo('char'));
    filePointers.set(pointerKey(value)!, stream);
    filePointerValues.set(stream, value);
    return value;
  };
  const standardFile = (kind: 'stdin' | 'stdout' | 'stderr', at: Location): CValue => {
    const known = standardFiles.get(kind);
    if (known) return known;
    const stream = kind === 'stdin' ? context.io!.stdin : kind === 'stdout' ? context.io!.stdout : context.io!.stderr;
    const value = makeFilePointer(stream, at);
    standardFiles.set(kind, value);
    standardFileKeys.add(pointerKey(value)!);
    return value;
  };
  const streamFor = (file: CValue, at: Location): VirtualStream | null => {
    if (file.value === null) return null;
    const key = pointerKey(file);
    if (!key) return null;
    const stream = filePointers.get(key) ?? null;
    if (stream?.isClosed) return null;
    void at;
    return stream;
  };

  return {
    filePointers,
    filePointerValues,
    standardFiles,
    standardFileKeys,
    pointerKey,
    asBytePointer,
    readBytes,
    preflightMemoryWrite,
    writeBytes,
    readCString,
    copyBytes,
    writeScalar,
    chargeWork,
    makeFilePointer,
    standardFile,
    streamFor,
  };
}
