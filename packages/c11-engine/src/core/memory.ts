import { enforceLimit, failure } from './internal.ts';
import { binary80Decode80, binary80Encode80, binary80Zero } from './binary80.ts';
import type {
  AggregateDefinition, AggregateValue, CType, CValue, FunctionPointerValue, Location, ObjectPointerValue,
  ObjectReference, ObjectScalarValue, ObjectSnapshot, StorageDuration,
} from './internal.ts';
import {
  aggregateType, alignOfType, arrayOf, arrayType, compatibleType, functionType, integerInfo, isAggregate, isArithmetic,
  isArray, isFunction, isInteger, isPointer, isScalar, pointerTo, pointedToType, qualifiersOf,
  pointerType, sameType, sizeOfType, unqualifiedType,
} from './type-system.ts';
import { VIRTUAL_HEAP_LAYOUT, VIRTUAL_MEMORY_LAYOUT } from './types.ts';
import type { DebugPointerStatus, EngineMetrics } from './types.ts';

const ALLOCATION_ALIGNMENT = BigInt(VIRTUAL_MEMORY_LAYOUT.alignmentBytes);
const CORRESPONDING_UNSIGNED: Readonly<Record<string, string>> = Object.freeze({
  'signed char': 'unsigned char',
  short: 'unsigned short',
  int: 'unsigned int',
  long: 'unsigned long',
  'long long': 'unsigned long long',
});
const CORRESPONDING_SIGNED: Readonly<Record<string, string>> = Object.freeze({
  'unsigned char': 'signed char',
  'unsigned short': 'short',
  'unsigned int': 'int',
  'unsigned long': 'long',
  'unsigned long long': 'long long',
});

interface AddressReservation {
  readonly virtualBase: bigint;
  /** End of the aligned extent, including its guard bytes. */
  readonly endExclusive: bigint;
  readonly heapSlotCount?: bigint;
}

interface RuntimeObject {
  readonly id: number;
  readonly allocationId: number;
  readonly type: CType;
  readonly byteOffset: number;
  readonly size: number;
  readonly duration: StorageDuration;
  readonly parentId?: number;
  readonly childIndex?: number;
  readonly memberIndex?: number;
  readonly rawAllocation: boolean;
  readonly rawView?: boolean;
  readonly byteView?: boolean;
  /** Initialization shadow imported by memcpy for a typed heap view. */
  initializationShadow?: ObjectSnapshot;
  initializationShadowApplied?: boolean;
  readonly alignment?: number;
  initialized: boolean;
  value?: ObjectScalarValue;
  zeroInitialized: boolean;
  activeMember?: number;
  readOnly?: boolean;
  alive: boolean;
  children: Map<number, RuntimeObject>;
}

interface AllocationRoot extends RuntimeObject {
  readonly allocationId: number;
  readonly virtualBase: bigint;
  readonly representation: Map<number, number>;
  /** Shadow provenance for complete LP64 object-pointer representations in this allocation. */
  readonly pointerValues: Map<number, ObjectPointerValue>;
  /** C types established for ranges of malloc storage by typed stores or byte copies. */
  readonly effectiveTypes: EffectiveTypeRange[];
  /** Original const subobjects remain protected even after a cast removes qualification. */
  readonly constRanges: ConstRange[];
  /** Pointer-typed subobjects whose cached C values can be invalidated by byte writes. */
  readonly pointerObjects: Set<RuntimeObject>;
  readonly heapSlotCount?: bigint;
}

interface EffectiveTypeRange {
  readonly start: number;
  readonly end: number;
  readonly type: CType;
  readonly initialization?: ObjectSnapshot;
}

interface ConstRange {
  readonly start: number;
  readonly end: number;
  /** A bit-field const subobject protects only its declared bits in the shared unit. */
  readonly bitMask?: bigint;
}

export interface MemoryAllocationOptions {
  readonly isConst?: boolean;
  readonly alignment?: number;
}

export interface EffectiveTypeCopy {
  readonly relativeOffset: number;
  readonly size: number;
  readonly type: CType;
  readonly initialization?: ObjectSnapshot;
}

interface RuntimeObjectDescription {
  readonly objectId: number;
  readonly allocationId: number;
  readonly duration: StorageDuration;
  readonly addressVirtual: bigint;
  readonly size: number;
}

interface RuntimeObjectViewDescription {
  readonly objectId: number;
  readonly allocationId: number;
  readonly duration: StorageDuration;
  readonly addressVirtual: bigint;
  readonly size: number;
}

/**
 * A session-local, typed object store. It models C object identity and lifetime
 * without exposing host memory or byte buffers to the language implementation.
 */
export class VirtualMemory {
  private readonly records = new Map<number, RuntimeObject>();
  private readonly roots = new Map<number, AllocationRoot>();
  private readonly staticObjects = new WeakMap<object, ObjectReference>();
  private readonly automaticObjects = new WeakMap<object, WeakMap<object, ObjectReference>>();
  private readonly scopeObjects = new WeakMap<object, ObjectReference[]>();
  private nextObjectId = 1;
  private liveBytes = 0;
  private readonly functionRepresentations = new Map<bigint, FunctionPointerValue>();
  private readonly formattedObjectPointers = new Map<bigint, ObjectPointerValue>();
  /** Provenance shadow for pointer -> uintptr_t -> pointer round trips. */
  private readonly integerPointerValues = new Map<bigint, ObjectPointerValue | FunctionPointerValue>();
  /** Occupied extents are indexed once per live allocation, not once per 16-byte slot. */
  private readonly heapExtents = new Map<bigint, bigint>();
  /** Static objects persist until the session ends. */
  private readonly staticExtents = new Map<bigint, bigint>();
  /** Automatic objects release their extents when their scope or frame ends. */
  private readonly stackExtents = new Map<bigint, bigint>();
  /** Retain old bases only for debug sessions so dangling pointer values keep their exact address. */
  private readonly pointerAllocationAddresses = new Map<number, bigint>();

  constructor(
    private readonly aggregates: readonly AggregateDefinition[],
    private readonly maxMemoryBytes: number | null,
    private readonly metrics: EngineMetrics,
    private readonly heapAddressRandom: () => number = Math.random,
    private readonly retainPointerAllocationAddresses = false,
  ) {}

  get allocatedBytes(): number { return this.liveBytes; }

  describeObject(ref: ObjectReference, at: Location): RuntimeObjectDescription {
    const node = this.nodeFor(ref, at);
    const root = this.roots.get(node.allocationId);
    if (!root) failure('INACTIVE_OBJECT', 'The reference does not identify an active allocation.', at);
    return {
      objectId: root.id,
      allocationId: root.allocationId,
      duration: root.duration,
      addressVirtual: root.virtualBase,
      size: root.size,
    };
  }

  /** Describe the exact typed view represented by a reference, not its allocation root. */
  describeObjectView(ref: ObjectReference, at: Location): RuntimeObjectViewDescription {
    const node = this.nodeFor(ref, at);
    const root = this.roots.get(node.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The reference does not identify an active allocation.', at);
    let size = node.size;
    const aggregate = aggregateType(node.type);
    if (aggregate) {
      const definition = this.aggregate(aggregate, at);
      // A flexible array member occupies the remaining storage supplied for its
      // containing object, even though sizeof(type) stops at the fixed prefix.
      if (definition.flexibleOffset !== undefined) {
        size = Math.max(size, root.byteOffset + root.size - node.byteOffset);
      }
    }
    return {
      objectId: node.id,
      allocationId: node.allocationId,
      duration: root.duration,
      addressVirtual: root.virtualBase + BigInt(node.byteOffset - root.byteOffset),
      size,
    };
  }

  rootReference(allocationId: number): ObjectReference | undefined {
    const root = this.roots.get(allocationId);
    return root?.alive ? this.reference(root) : undefined;
  }

  heapAggregateReferences(): readonly ObjectReference[] {
    const references: ObjectReference[] = [];
    for (const [allocationId, views] of this.rawViews) {
      const root = this.roots.get(allocationId);
      if (!root?.alive || root.duration !== 'heap') continue;
      for (const view of views.values()) {
        if (!view.alive || !aggregateType(view.type)) continue;
        references.push(this.reference(view));
      }
    }
    return Object.freeze(references);
  }

  flexibleArrayExtent(ref: ObjectReference, memberIndex: number, at: Location): {
    readonly elementSize: number;
    readonly capacityBytes: number;
    readonly length: number;
  } | undefined {
    const node = this.nodeFor(ref, at);
    const aggregate = aggregateType(node.type);
    if (!aggregate) return undefined;
    const definition = this.aggregate(aggregate, at);
    const member = definition.members[memberIndex];
    if (!member?.flexibleArray || definition.flexibleOffset === undefined) return undefined;
    const array = arrayType(member.type);
    if (!array) return undefined;
    const elementSize = sizeOfType(array.element, this.aggregates, member.location);
    const offset = node.byteOffset + definition.flexibleOffset;
    const capacityBytes = Math.max(0, this.rootFor(node, at).size - offset);
    return Object.freeze({ elementSize, capacityBytes, length: Math.floor(capacityBytes / elementSize) });
  }

  /** Inspect one arithmetic FAM cell from representation/shadow state without creating a subobject or C read. */
  inspectFlexibleArrayElement(
    ref: ObjectReference,
    memberIndex: number,
    index: number,
    at: Location,
  ): { readonly initialized: boolean; readonly value?: ObjectScalarValue } | undefined {
    const parent = this.nodeFor(ref, at);
    const aggregate = aggregateType(parent.type);
    if (!aggregate) return undefined;
    const definition = this.aggregate(aggregate, at);
    const member = definition.members[memberIndex];
    const array = member?.flexibleArray ? arrayType(member.type) : undefined;
    if (!member?.flexibleArray || !array || !isArithmetic(array.element) || definition.flexibleOffset === undefined) return undefined;
    const extent = this.flexibleArrayExtent(ref, memberIndex, at);
    if (!extent || !Number.isSafeInteger(index) || index < 0 || index >= extent.length) return undefined;

    const arrayNode = parent.children.get(memberIndex);
    const child = arrayNode?.children.get(index);
    const zeroInitialized = child
      ? this.hasZeroInitializedAncestor(child)
      : arrayNode
        ? this.hasZeroInitializedAncestor(arrayNode)
        : this.hasZeroInitializedAncestor(parent);
    const byteOffset = parent.byteOffset + definition.flexibleOffset + index * extent.elementSize;
    return this.inspectArithmeticRepresentation(
      this.rootFor(parent, at),
      array.element,
      byteOffset,
      extent.elementSize,
      child?.initialized ?? false,
      zeroInitialized,
      at,
    );
  }

  isAlive(ref: ObjectReference): boolean {
    const node = this.records.get(ref.objectId);
    return !!node && node.allocationId === ref.allocationId && node.alive && !!this.roots.get(node.allocationId)?.alive;
  }

  findStaticObject(key: object): ObjectReference | undefined { return this.staticObjects.get(key); }

  findAutomaticObject(key: object, scopeToken: object): ObjectReference | undefined {
    return this.automaticObjects.get(key)?.get(scopeToken);
  }

  scopeObjectReferences(scopeToken: object): readonly ObjectReference[] {
    return (this.scopeObjects.get(scopeToken) ?? []).filter((ref) => this.isAlive(ref));
  }

  canFree(pointer: ObjectPointerValue | null): boolean {
    if (pointer === null) return false;
    const root = this.roots.get(pointer.allocationId);
    return !!root?.alive && root.duration === 'heap' && root.rawAllocation &&
      pointer.byteOffset === root.byteOffset && pointer.arrayId === root.id;
  }

  allocate(type: CType, duration: StorageDuration, at: Location, options: MemoryAllocationOptions = {}): ObjectReference {
    const size = sizeOfType(type, this.aggregates, at);
    const naturalAlignment = alignOfType(type, this.aggregates, at);
    const alignment = Math.max(naturalAlignment, options.alignment ?? 1);
    this.validateAlignment(alignment, at);
    return this.allocateRoot(type, size, duration, at, false, undefined, undefined, undefined, { ...options, alignment });
  }

  allocateRaw(bytes: number, at: Location): ObjectPointerValue | null {
    return this.allocateRawAligned(bytes, Number(ALLOCATION_ALIGNMENT), at);
  }

  allocateRawAligned(bytes: number, alignment: number, at: Location): ObjectPointerValue | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) failure('INVALID_ALLOCATION_SIZE', 'malloc requires a nonnegative safe integer size.', at);
    this.validateAlignment(alignment, at);
    // This profile chooses the permitted C11 behavior that malloc(0) returns null.
    if (bytes === 0) return null;
    const nextBytes = this.nextAllocationByteCount(bytes, at);
    const heapAddress = this.chooseHeapAddress(bytes, at, undefined, alignment);
    if (!heapAddress) return null;
    const root = this.allocateRoot(
      arrayOf('unsigned char', bytes), bytes, 'heap', at, true,
      nextBytes, heapAddress,
    );
    return {
      kind: 'object-pointer', allocationId: root.allocationId, arrayId: root.objectId,
      byteOffset: root.byteOffset, boundsStart: root.byteOffset, boundsEnd: root.byteOffset + bytes,
    };
  }

  reallocateRaw(pointer: ObjectPointerValue | null, bytes: number, at: Location): ObjectPointerValue | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) failure('INVALID_ALLOCATION_SIZE', 'realloc requires a nonnegative safe integer size.', at);
    if (pointer === null) return this.allocateRaw(bytes, at);

    const oldRoot = this.roots.get(pointer.allocationId);
    if (!this.canFree(pointer) || !oldRoot) {
      failure('INVALID_REALLOC', 'realloc requires null or the base pointer of a live heap block.', at);
    }
    if (bytes === 0) {
      this.free(pointer, at);
      return null;
    }

    const nextBytes = this.liveBytes - oldRoot.size + bytes;
    enforceLimit('maxMemoryBytes', nextBytes, this.maxMemoryBytes, at);

    const oldFirstHeapSlot = (oldRoot.virtualBase - VIRTUAL_HEAP_LAYOUT.start) / ALLOCATION_ALIGNMENT;
    const reservation = this.heapReservationAt(bytes, oldRoot.virtualBase, oldFirstHeapSlot) ??
      this.chooseHeapAddress(bytes, at, oldFirstHeapSlot);
    if (!reservation) return null;

    const copiedBytes = Math.min(oldRoot.size, bytes);
    const representation = new Map(
      [...oldRoot.representation].filter(([offset]) => offset >= 0 && offset < copiedBytes),
    );
    const pointerValues = new Map(
      [...oldRoot.pointerValues]
        .filter(([offset]) => offset >= 0 && offset + 8 <= copiedBytes)
        .map(([offset, value]) => [offset, { ...value }] as const),
    );
    const effectiveTypes = oldRoot.effectiveTypes
      .filter((range) => range.start >= 0 && range.end <= copiedBytes)
      .map((range) => ({ ...range }));

    const newReference = this.allocateRoot(
      arrayOf('unsigned char', bytes), bytes, 'heap', at, true,
      nextBytes, reservation, oldFirstHeapSlot,
    );
    const newRoot = this.roots.get(newReference.allocationId);
    if (!newRoot) failure('ENGINE_INTERNAL_ERROR', 'Missing root for a newly reallocated heap object.', at);
    for (const [offset, byte] of representation) newRoot.representation.set(offset, byte);
    for (const [offset, value] of pointerValues) newRoot.pointerValues.set(offset, value);
    newRoot.effectiveTypes.push(...effectiveTypes);

    // A successful realloc creates a fresh C object identity even when its address stays put.
    this.invalidateRoot(oldRoot.allocationId, at);
    const newFirstHeapSlot = (newRoot.virtualBase - VIRTUAL_HEAP_LAYOUT.start) / ALLOCATION_ALIGNMENT;
    this.heapExtents.set(newFirstHeapSlot, newFirstHeapSlot + newRoot.heapSlotCount!);
    this.liveBytes = nextBytes;

    return {
      kind: 'object-pointer', allocationId: newRoot.allocationId, arrayId: newRoot.id,
      byteOffset: newRoot.byteOffset, boundsStart: newRoot.byteOffset, boundsEnd: newRoot.byteOffset + bytes,
    };
  }

  release(ref: ObjectReference, at: Location): void {
    const node = this.nodeFor(ref, at);
    if (node.id !== node.allocationId) failure('INVALID_OBJECT_RELEASE', 'Only the lifetime of an automatic root object can be ended.', at);
    if (node.duration !== 'automatic' && node.duration !== 'compound-literal') failure('INVALID_OBJECT_RELEASE', 'The object does not have automatic storage duration.', at);
    this.invalidateRoot(node.allocationId, at);
  }

  free(pointer: ObjectPointerValue | null, at: Location): void {
    if (pointer === null) return;
    const root = this.roots.get(pointer.allocationId);
    if (!root || !root.alive || root.duration !== 'heap' || !root.rawAllocation || pointer.byteOffset !== root.byteOffset || pointer.arrayId !== root.id) {
      failure('INVALID_FREE', 'free requires null or the base pointer of a live heap block.', at);
    }
    this.invalidateRoot(root.allocationId, at);
  }

  staticObject(
    key: object,
    type: CType,
    at: Location,
    duration: StorageDuration = 'static',
    options: MemoryAllocationOptions = {},
  ): ObjectReference {
    const prior = this.staticObjects.get(key);
    if (prior) return prior;
    const ref = this.allocate(type, duration, at, options);
    this.staticObjects.set(key, ref);
    if (duration === 'string-literal') this.nodeFor(ref, at).readOnly = true;
    return ref;
  }

  stringLiteral(key: object, bytes: readonly number[], at: Location): ObjectReference {
    const prior = this.staticObjects.get(key);
    if (prior) return prior;
    const ref = this.allocate(arrayOf('char', bytes.length + 1), 'string-literal', at);
    this.staticObjects.set(key, ref);
    for (let index = 0; index <= bytes.length; index++) {
      const byte = index === bytes.length ? 0 : bytes[index];
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) failure('INVALID_STRING_LITERAL', 'The string literal contains a non-byte code unit.', at);
      const element = this.element(ref, index, at);
      const value = BigInt.asIntN(8, BigInt(byte));
      const node = this.nodeFor(element, at);
      node.value = value;
      node.initialized = true;
      this.writeRepresentation(node, value, at);
    }
    this.nodeFor(ref, at).readOnly = true;
    return ref;
  }

  automaticObject(
    key: object,
    type: CType,
    scopeToken: object,
    at: Location,
    options: MemoryAllocationOptions = {},
  ): ObjectReference {
    let byScope = this.automaticObjects.get(key);
    if (!byScope) { byScope = new WeakMap(); this.automaticObjects.set(key, byScope); }
    const prior = byScope.get(scopeToken);
    if (prior) return prior;
    const ref = this.allocate(type, 'compound-literal', at, options);
    byScope.set(scopeToken, ref);
    let objects = this.scopeObjects.get(scopeToken);
    if (!objects) { objects = []; this.scopeObjects.set(scopeToken, objects); }
    objects.push(ref);
    return ref;
  }

  releaseScope(scopeToken: object, at: Location): void {
    const objects = this.scopeObjects.get(scopeToken);
    if (!objects) return;
    for (let index = objects.length - 1; index >= 0; index--) {
      const ref = objects[index];
      const root = this.roots.get(ref.allocationId);
      if (root?.alive) this.invalidateRoot(root.allocationId, at);
    }
    this.scopeObjects.delete(scopeToken);
  }

  element(ref: ObjectReference, index: number | bigint, at: Location): ObjectReference {
    const parent = this.nodeFor(ref, at);
    const array = arrayType(parent.type);
    if (!array) failure('INVALID_SUBSCRIPT', 'Subscript requires an array object.', at);
    const numericIndex = typeof index === 'bigint' ? Number(index) : index;
    if (!Number.isSafeInteger(numericIndex) || numericIndex < 0 || array.length === null || numericIndex >= array.length) {
      failure('ARRAY_BOUNDS', 'The index is outside the array bounds.', at);
    }
    return this.child(parent, numericIndex, at);
  }

  member(ref: ObjectReference, index: number, at: Location): ObjectReference {
    const parent = this.nodeFor(ref, at);
    const aggregate = aggregateType(parent.type);
    if (!aggregate) failure('INVALID_MEMBER_ACCESS', 'Member access requires a struct or union.', at);
    const definition = this.aggregate(aggregate, at);
    const member = definition.members[index];
    if (!member) failure('UNKNOWN_MEMBER', `No member exists at index ${index}.`, at);
    if (member.bitField?.width === 0) failure('INVALID_MEMBER_ACCESS', 'An unnamed or zero-width bit-field is inaccessible.', at);
    return this.child(parent, index, at, member);
  }

  dereference(pointer: CValue, at: Location): ObjectReference {
    const targetType = pointedToType(pointer.type);
    if (!targetType) failure('INVALID_POINTER_ACCESS', 'Dereference requires a pointer.', at);
    const targetBase = unqualifiedType(targetType);
    if (targetBase === 'void' || isFunction(targetBase)) failure('INVALID_POINTER_ACCESS', 'The pointer does not designate a complete object.', at);
    if (pointer.value === null) failure('NULL_DEREFERENCE', 'Cannot dereference a null pointer.', at);
    const address = pointer.value as ObjectPointerValue;
    if (!address || address.kind !== 'object-pointer') failure('INVALID_POINTER_ACCESS', 'The value is not an object address.', at);
    const root = this.roots.get(address.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The pointer refers to an object whose lifetime has ended.', at);
    const size = sizeOfType(targetType, this.aggregates, at);
    const end = address.byteOffset + size;
    if (address.byteOffset < address.boundsStart || address.byteOffset >= address.boundsEnd || end > address.boundsEnd) {
      failure('POINTER_BOUNDS', 'Access is outside the pointed-to object or uses a one-past pointer.', at);
    }
    const alignment = this.alignment(targetType, at);
    if ((root.virtualBase + BigInt(address.byteOffset)) % BigInt(alignment) !== 0n) failure('MISALIGNED_POINTER', 'The pointer does not meet the alignment of the pointed-to type.', at);
    const target = this.locate(root, address.byteOffset, targetType, at);
    return this.reference(target, {
      arrayId: address.arrayId,
      boundsStart: address.boundsStart,
      boundsEnd: address.boundsEnd,
      arrayIndex: this.arrayIndex(address),
    });
  }

  addressOf(ref: ObjectReference, pointerCType?: Extract<CType, { kind: 'pointer' }>): CValue {
    const node = this.nodeFor(ref, { file: 'main.c', line: 1, column: 1 });
    const targetType: CType = pointerCType ?? { kind: 'pointer', base: node.type };
    const pointer = pointerType(targetType);
    const pointedType = pointer ? pointedToType(targetType) : undefined;
    if (!pointer || !pointedType || !compatibleType(unqualifiedType(pointedType), unqualifiedType(node.type))) {
      failure('TYPE_ERROR', 'The pointer type does not match the addressed object.', { file: 'main.c', line: 1, column: 1 });
    }
    const size = node.size;
    const boundsStart = ref.arrayId !== undefined ? ref.boundsStart ?? node.byteOffset : node.byteOffset;
    const boundsEnd = ref.arrayId !== undefined ? ref.boundsEnd ?? node.byteOffset + size : node.byteOffset + size;
    const arrayId = ref.arrayId ?? node.id;
    const value: ObjectPointerValue = {
      kind: 'object-pointer', allocationId: node.allocationId, arrayId,
      byteOffset: node.byteOffset, boundsStart, boundsEnd,
    };
    return { type: targetType, value };
  }

  decay(ref: ObjectReference): CValue {
    const node = this.nodeFor(ref, { file: 'main.c', line: 1, column: 1 });
    const array = arrayType(node.type);
    if (!array) failure('INVALID_ARRAY_DECAY', 'Array-to-pointer conversion requires an array.', { file: 'main.c', line: 1, column: 1 });
    return {
      type: { kind: 'pointer', base: array.element },
      value: {
        kind: 'object-pointer', allocationId: node.allocationId, arrayId: node.id,
        byteOffset: node.byteOffset, boundsStart: node.byteOffset, boundsEnd: node.byteOffset + node.size,
      },
    };
  }

  pointerAdd(pointer: CValue, count: bigint, at: Location): CValue {
    const targetType = pointedToType(pointer.type);
    if (!targetType || unqualifiedType(targetType) === 'void' || isFunction(targetType) || !pointer.value) {
      failure('INVALID_POINTER_ARITHMETIC', 'Pointer arithmetic requires a non-null pointer to a complete object type.', at);
    }
    if (typeof pointer.value !== 'object' || pointer.value.kind !== 'object-pointer') failure('INVALID_POINTER_ARITHMETIC', 'Pointer arithmetic requires an object pointer.', at);
    this.assertAlive(pointer, at);
    const address = pointer.value;
    const stride = sizeOfType(targetType, this.aggregates, at);
    const offset = BigInt(address.byteOffset) + count * BigInt(stride);
    if (offset < BigInt(address.boundsStart) || offset > BigInt(address.boundsEnd) || (offset - BigInt(address.boundsStart)) % BigInt(stride) !== 0n) {
      failure('POINTER_BOUNDS', 'Pointer arithmetic produced an address outside the array or beyond one-past.', at);
    }
    const result = Number(offset);
    if (!Number.isSafeInteger(result)) failure('POINTER_BOUNDS', 'The virtual address exceeds the representable profile.', at);
    return { type: pointer.type, value: { ...address, byteOffset: result } };
  }

  pointerDifference(left: CValue, right: CValue, at: Location): CValue {
    const leftBase = pointedToType(left.type), rightBase = pointedToType(right.type);
    const characterRepresentation = !!leftBase && !!rightBase && isCharacterType(leftBase) && isCharacterType(rightBase);
    if (!leftBase || !rightBase || !sameType(leftBase, rightBase) || !left.value || !right.value ||
      typeof left.value !== 'object' || typeof right.value !== 'object' || left.value.kind !== 'object-pointer' || right.value.kind !== 'object-pointer') {
      failure('INVALID_POINTER_DIFFERENCE', 'Pointer subtraction requires compatible pointers into the same array.', at);
    }
    this.assertAlive(left, at);
    this.assertAlive(right, at);
    const a = left.value, b = right.value;
    if (a.allocationId !== b.allocationId || (!characterRepresentation && a.arrayId !== b.arrayId)) {
      failure('INVALID_POINTER_DIFFERENCE', 'Subtracting pointers to distinct objects is undefined.', at);
    }
    const stride = sizeOfType(leftBase, this.aggregates, at);
    const difference = BigInt(a.byteOffset - b.byteOffset);
    if (difference % BigInt(stride) !== 0n) failure('INVALID_POINTER_DIFFERENCE', 'The difference is not an integer number of elements.', at);
    const result = difference / BigInt(stride);
    if (result < -(1n << 63n) || result > (1n << 63n) - 1n) failure('POINTER_DIFFERENCE_RANGE', 'Pointer difference exceeds ptrdiff_t in this profile.', at);
    return { type: 'long', value: result };
  }

  pointerRelationalCompare(left: CValue, right: CValue, operator: string, at: Location): boolean {
    const leftBase = pointedToType(left.type), rightBase = pointedToType(right.type);
    if (!leftBase || !rightBase || !compatibleType(unqualifiedType(leftBase), unqualifiedType(rightBase)) ||
        !left.value || !right.value || typeof left.value !== 'object' || typeof right.value !== 'object' ||
        left.value.kind !== 'object-pointer' || right.value.kind !== 'object-pointer') {
      failure('INVALID_POINTER_COMPARISON', 'Relational comparison requires pointers to compatible objects.', at);
    }
    const a = left.value, b = right.value;
    this.assertAlive(left, at);
    this.assertAlive(right, at);
    if (a.allocationId !== b.allocationId) {
      failure('INVALID_POINTER_COMPARISON', 'Relational comparison of pointers to distinct objects is undefined.', at);
    }

    let comparison: number;
    if (a.arrayId === b.arrayId) {
      comparison = a.byteOffset < b.byteOffset ? -1 : a.byteOffset > b.byteOffset ? 1 : 0;
    } else {
      const leftObject = this.records.get(a.arrayId);
      const rightObject = this.records.get(b.arrayId);
      const parentId = leftObject?.parentId;
      const parent = parentId === undefined ? undefined : this.records.get(parentId);
      if (!leftObject || !rightObject || leftObject.byteOffset !== a.byteOffset || rightObject.byteOffset !== b.byteOffset ||
          !sameType(leftObject.type, leftBase) || !sameType(rightObject.type, rightBase) ||
          parentId === undefined || parentId !== rightObject.parentId || !parent || !aggregateType(parent.type)) {
        failure('INVALID_POINTER_COMPARISON', 'Relational comparison requires elements of the same array or members of the same aggregate.', at);
      }
      const definition = this.aggregate(parent.type, at);
      if (leftObject.memberIndex === undefined || rightObject.memberIndex === undefined) {
        failure('INVALID_POINTER_COMPARISON', 'Relational comparison requires members of the same aggregate.', at);
      }
      if (definition.kind === 'union') comparison = 0;
      else comparison = leftObject.memberIndex < rightObject.memberIndex ? -1
        : leftObject.memberIndex > rightObject.memberIndex ? 1 : 0;
    }

    return operator === '<' ? comparison < 0
      : operator === '>' ? comparison > 0
        : operator === '<=' ? comparison <= 0 : comparison >= 0;
  }

  assertAlive(pointer: CValue, at: Location): void {
    if (pointer.value === null) return;
    if (typeof pointer.value !== 'object') failure('INVALID_POINTER_ACCESS', 'The value does not represent a pointer.', at);
    if (pointer.value.kind === 'function-pointer') return;
    if (pointer.value.kind !== 'object-pointer') failure('INVALID_POINTER_ACCESS', 'The value does not represent an object pointer.', at);
    const root = this.roots.get(pointer.value.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The pointer refers to an object whose lifetime has ended.', at);
  }

  /** Format the actual LP64 virtual pointer representation for the library's %p conversion. */
  formatPointer(pointer: CValue, at: Location): string {
    if (!isPointer(pointer.type)) failure('INVALID_POINTER_FORMAT', 'The %p value is not a pointer.', at);
    if (pointer.value === null) return '0x0';
    if (typeof pointer.value !== 'object') failure('INVALID_POINTER_FORMAT', 'The %p value is not a pointer representation.', at);
    if (pointer.value.kind === 'object-pointer') {
      this.assertAlive(pointer, at);
      const value = pointer.value;
      const root = this.roots.get(value.allocationId);
      const array = this.records.get(value.arrayId);
      if (!root || !array || array.allocationId !== value.allocationId || value.boundsStart < 0 ||
          value.boundsEnd > root.size || value.boundsStart > value.byteOffset || value.byteOffset > value.boundsEnd) {
        failure('INVALID_POINTER_REPRESENTATION', 'The pointer does not retain valid provenance for %p.', at);
      }
      const address = root.virtualBase + BigInt(value.byteOffset);
      this.formattedObjectPointers.set(address, value);
      return `0x${address.toString(16)}`;
    }
    if (pointer.value.kind === 'function-pointer') {
      if (pointer.value.functionIndex === null) return '0x0';
      if (!Number.isSafeInteger(pointer.value.functionIndex) || pointer.value.functionIndex < 0) {
        failure('INVALID_POINTER_FORMAT', 'The function pointer does not have a valid representation.', at);
      }
      return `0x${((1n << 63n) | BigInt(pointer.value.functionIndex + 1)).toString(16)}`;
    }
    failure('INVALID_POINTER_FORMAT', 'The %p value is not a pointer.', at);
  }

  /** Return the session's LP64 representation for an object or function pointer cast. */
  pointerInteger(pointer: CValue, at: Location): bigint {
    if (!isPointer(pointer.type)) failure('INVALID_CONVERSION', 'Conversion requires a pointer.', at);
    if (pointer.value === null) return 0n;
    if (typeof pointer.value !== 'object') failure('INVALID_POINTER_REPRESENTATION', 'The value does not represent a pointer.', at);
    if (pointer.value.kind === 'function-pointer') {
      if (pointer.value.functionIndex === null) return 0n;
      const address = (1n << 63n) | BigInt(pointer.value.functionIndex + 1);
      this.integerPointerValues.set(address, { ...pointer.value });
      return address;
    }
    if (pointer.value.kind !== 'object-pointer') failure('INVALID_POINTER_REPRESENTATION', 'The value does not represent a pointer.', at);
    this.assertAlive(pointer, at);
    const root = this.roots.get(pointer.value.allocationId);
    if (!root) failure('INVALID_POINTER_REPRESENTATION', 'The pointer does not identify a virtual object.', at);
    const address = root.virtualBase + BigInt(pointer.value.byteOffset);
    this.integerPointerValues.set(address, { ...pointer.value });
    return address;
  }

  /** Reconstruct only known or currently mapped virtual addresses; provenance is retained when available. */
  pointerFromInteger(value: bigint, type: CType, at: Location): CValue {
    const pointer = pointerType(type);
    if (!pointer) failure('INVALID_CONVERSION', 'Integer conversion requires a pointer type.', at);
    const address = BigInt.asUintN(64, value);
    if (address === 0n) return { type, value: null };
    const expectsFunction = isFunction(pointedToType(type) ?? 'void');
    const remembered = this.integerPointerValues.get(address) ?? this.formattedObjectPointers.get(address) ?? this.functionRepresentations.get(address);
    if (remembered) {
      if (expectsFunction !== (remembered.kind === 'function-pointer')) {
        failure('INVALID_POINTER_CONVERSION', 'The integer representation belongs to a different pointer category.', at);
      }
      return { type, value: { ...remembered } };
    }
    if (expectsFunction) failure('INVALID_POINTER_REPRESENTATION', 'The integer does not correspond to a known function address.', at);
    for (const root of this.roots.values()) {
      const delta = address - root.virtualBase;
      if (delta < 0n || delta > BigInt(root.size)) continue;
      const byteOffset = Number(delta);
      return {
        type,
        value: {
          kind: 'object-pointer', allocationId: root.allocationId, arrayId: root.id,
          byteOffset, boundsStart: 0, boundsEnd: root.size,
        },
      };
    }
    failure('INVALID_POINTER_REPRESENTATION', 'The integer does not correspond to a known virtual address.', at);
  }

  /** Parse only null or an object-pointer representation previously emitted by formatPointer. */
  parsePointer(text: string, at: Location): CValue {
    const match = /^0[xX]([0-9a-fA-F]+)$/.exec(text);
    if (!match) failure('INVALID_POINTER_REPRESENTATION', 'The %p input does not match a representation emitted by %p.', at);
    const address = BigInt(`0x${match[1]}`);
    if (address === 0n) return { type: pointerTo('void'), value: null };
    const value = this.formattedObjectPointers.get(address);
    if (!value) failure('INVALID_POINTER_REPRESENTATION', 'The %p input does not correspond to a known object pointer.', at);
    const pointer: CValue = { type: pointerTo('void'), value };
    this.assertAlive(pointer, at);
    return pointer;
  }

  pointerEqual(left: CValue, right: CValue, at: Location = { file: 'main.c', line: 1, column: 1 }): boolean {
    this.assertAlive(left, at);
    this.assertAlive(right, at);
    if (left.value === null || right.value === null) return left.value === null && right.value === null;
    if (typeof left.value !== 'object' || typeof right.value !== 'object') return false;
    if (left.value.kind === 'function-pointer' && right.value.kind === 'function-pointer') return left.value.functionIndex === right.value.functionIndex;
    if (left.value.kind === 'object-pointer' && right.value.kind === 'object-pointer') {
      return left.value.allocationId === right.value.allocationId && left.value.byteOffset === right.value.byteOffset;
    }
    return false;
  }

  read(ref: ObjectReference, at: Location): CValue {
    const node = this.nodeFor(ref, at);
    if (isArray(node.type)) failure('ARRAY_VALUE', 'An array must decay to a pointer before it can be evaluated as an expression.', at);
    if (isAggregate(node.type)) {
      this.ensureEffectiveType(node, at);
      const aggregate: AggregateValue = { kind: 'aggregate-value', snapshot: this.snapshot(node, at) };
      return { type: unqualifiedType(node.type), value: aggregate };
    }
    const bitField = this.bitFieldFor(node, at);
    if (bitField) {
      this.ensureEffectiveType(node, at);
      const type = this.bitFieldPromotionType(node.type, bitField.member.bitField!);
      return { type, value: this.readBitField(node, bitField.member.bitField!, at) };
    }
    this.ensureEffectiveType(node, at);
    return { type: unqualifiedType(node.type), value: this.readScalar(node, at) };
  }

  /** Inspect an arithmetic scalar without turning an indeterminate read into a VM diagnostic. */
  inspectScalar(ref: ObjectReference, at: Location): { readonly initialized: boolean; readonly value?: ObjectScalarValue } {
    const node = this.nodeFor(ref, at);
    if (!isScalar(node.type) || isPointer(node.type)) {
      failure('TYPE_ERROR', 'Scalar inspection requires an arithmetic object.', at);
    }
    const root = this.rootFor(node, at);
    const zeroInitialized = this.hasZeroInitializedAncestor(node);
    let fullyRepresented = true;
    for (let index = 0; index < node.size; index++) {
      if (!root.representation.has(node.byteOffset + index)) {
        fullyRepresented = false;
        break;
      }
    }
    const initialized = node.initialized || zeroInitialized || fullyRepresented;
    return initialized
      ? { initialized: true, value: this.readScalar(node, at) }
      : { initialized: false };
  }

  /** Inspect pointer bytes and provenance without invoking a C pointer read or validating its target. */
  inspectPointer(ref: ObjectReference, at: Location): {
    readonly initialized: boolean;
    readonly status: DebugPointerStatus;
    readonly address?: bigint;
    readonly target?: { readonly allocationId: number; readonly byteOffset: number };
  } {
    const node = this.nodeFor(ref, at);
    if (!isPointer(node.type)) failure('TYPE_ERROR', 'Pointer inspection requires a pointer object.', at);
    const root = this.rootFor(node, at);
    const zeroInitialized = this.hasZeroInitializedAncestor(node);
    let fullyRepresented = true;
    for (let index = 0; index < node.size; index++) {
      if (!root.representation.has(node.byteOffset + index)) {
        fullyRepresented = false;
        break;
      }
    }
    const initialized = node.initialized || zeroInitialized || fullyRepresented;
    if (!initialized) return { initialized: false, status: 'uninitialized' };

    const value = root.pointerValues.get(node.byteOffset) ?? node.value;
    if (value === null) return { initialized: true, status: 'null', address: 0n };
    if (typeof value === 'object' && value !== null && value.kind === 'object-pointer') {
      if (!Number.isSafeInteger(value.byteOffset)) {
        return { initialized: true, status: 'unmapped' };
      }
      const target = { allocationId: value.allocationId, byteOffset: value.byteOffset };
      const targetRoot = this.roots.get(value.allocationId);
      const base = targetRoot?.virtualBase ?? this.pointerAllocationAddresses.get(value.allocationId);
      if (base === undefined) return { initialized: true, status: 'unmapped', target };
      const address = base + BigInt(value.byteOffset);
      if (!targetRoot) return { initialized: true, status: 'dangling', address, target };
      if (value.byteOffset === value.boundsEnd) return { initialized: true, status: 'one-past', address, target };
      if (value.byteOffset < value.boundsStart || value.byteOffset > value.boundsEnd) {
        return { initialized: true, status: 'unmapped', address, target };
      }
      return { initialized: true, status: 'live', address, target };
    }
    if (typeof value === 'object' && value !== null && value.kind === 'function-pointer') {
      const address = value.functionIndex === null
        ? 0n
        : (1n << 63n) | BigInt(value.functionIndex + 1);
      return address === 0n
        ? { initialized: true, status: 'null', address }
        : { initialized: true, status: 'function', address };
    }

    let address = 0n;
    for (let index = 0; index < node.size; index++) {
      const byte = root.representation.get(node.byteOffset + index) ?? (zeroInitialized ? 0 : undefined);
      if (byte === undefined) return { initialized: true, status: 'unmapped' };
      address |= BigInt(byte) << BigInt(index * 8);
    }
    if (address === 0n) return { initialized: true, status: 'null', address };
    if (isFunction(pointedToType(node.type) ?? 'void') &&
        (this.functionRepresentations.has(address) || (address & (1n << 63n)) !== 0n)) {
      return { initialized: true, status: 'function', address };
    }
    // Raw bytes alone never establish object identity, even if their address now falls
    // inside a newer allocation that reused a retired object's address.
    return { initialized: true, status: 'unmapped', address };
  }

  /** Inspect an arithmetic array cell without creating its subobject node or performing a C read. */
  inspectArrayElement(
    ref: ObjectReference,
    index: number,
    at: Location,
  ): { readonly initialized: boolean; readonly value?: ObjectScalarValue } | undefined {
    const parent = this.nodeFor(ref, at);
    const array = arrayType(parent.type);
    if (!array || array.length === null ||
        !Number.isSafeInteger(index) || index < 0 || index >= array.length ||
        !isArithmetic(array.element)) return undefined;

    const type = array.element;
    const size = sizeOfType(type, this.aggregates, at);
    const byteOffset = parent.byteOffset + index * size;
    const root = this.rootFor(parent, at);
    const child = parent.children.get(index);
    const zeroInitialized = child
      ? this.hasZeroInitializedAncestor(child)
      : this.hasZeroInitializedAncestor(parent);
    const fullyRepresented = Array.from({ length: size }, (_, byte) => root.representation.has(byteOffset + byte)).every(Boolean);
    if (!child?.initialized && !zeroInitialized && !fullyRepresented) return { initialized: false };

    const bytes = Array.from({ length: size }, (_, byte) =>
      root.representation.get(byteOffset + byte) ?? (zeroInitialized ? 0 : undefined));
    // Malformed or partially written representation metadata must stay an
    // indeterminate display state rather than becoming a diagnosticable C read.
    if (bytes.some((byte) => byte === undefined)) return { initialized: false };
    return { initialized: true, value: this.decodeScalar(type, bytes as number[], at) };
  }

  /** Inspect a direct arithmetic struct member without creating its lazy child node. */
  inspectAggregateScalar(ref: ObjectReference, memberIndex: number, at: Location): { readonly initialized: boolean; readonly value?: ObjectScalarValue } {
    const member = this.directStructMember(ref, memberIndex, at);
    if (!isArithmetic(member.type)) failure('TYPE_ERROR', 'Inspection requires an arithmetic struct member.', at);
    const child = member.parent.children.get(memberIndex);
    const definition = this.aggregate(member.parent.type, at);
    const bitField = definition.members[memberIndex]?.bitField;
    if (bitField) {
      const initialized = !!child?.initialized || member.zeroInitialized;
      return initialized
        ? { initialized: true, value: this.readBitField(child ?? this.nodeFor(this.member(ref, memberIndex, at), at), bitField, at) }
        : { initialized: false };
    }
    return this.inspectArithmeticRepresentation(
      member.root,
      member.type,
      member.byteOffset,
      sizeOfType(member.type, this.aggregates, at),
      child?.initialized ?? false,
      member.zeroInitialized,
      at,
    );
  }

  /** Inspect a direct pointer struct member without creating its lazy child node. */
  inspectAggregatePointer(ref: ObjectReference, memberIndex: number, at: Location): {
    readonly initialized: boolean;
    readonly status: DebugPointerStatus;
    readonly address?: bigint;
    readonly target?: { readonly allocationId: number; readonly byteOffset: number };
  } {
    const member = this.directStructMember(ref, memberIndex, at);
    if (!isPointer(member.type)) failure('TYPE_ERROR', 'Inspection requires a pointer struct member.', at);
    const child = member.parent.children.get(memberIndex);
    const size = sizeOfType(member.type, this.aggregates, at);
    let fullyRepresented = true;
    for (let index = 0; index < size; index++) {
      if (!member.root.representation.has(member.byteOffset + index)) {
        fullyRepresented = false;
        break;
      }
    }
    const initialized = !!child?.initialized || member.zeroInitialized || fullyRepresented;
    if (!initialized) return { initialized: false, status: 'uninitialized' };

    const value = member.root.pointerValues.get(member.byteOffset) ?? child?.value;
    if (value === null) return { initialized: true, status: 'null', address: 0n };
    if (typeof value === 'object' && value !== null && value.kind === 'object-pointer') {
      if (!Number.isSafeInteger(value.byteOffset)) return { initialized: true, status: 'unmapped' };
      const target = { allocationId: value.allocationId, byteOffset: value.byteOffset };
      const targetRoot = this.roots.get(value.allocationId);
      const base = targetRoot?.virtualBase ?? this.pointerAllocationAddresses.get(value.allocationId);
      if (base === undefined) return { initialized: true, status: 'unmapped', target };
      const address = base + BigInt(value.byteOffset);
      if (!targetRoot) return { initialized: true, status: 'dangling', address, target };
      if (value.byteOffset === value.boundsEnd) return { initialized: true, status: 'one-past', address, target };
      if (value.byteOffset < value.boundsStart || value.byteOffset > value.boundsEnd) {
        return { initialized: true, status: 'unmapped', address, target };
      }
      return { initialized: true, status: 'live', address, target };
    }
    if (typeof value === 'object' && value !== null && value.kind === 'function-pointer') {
      const address = value.functionIndex === null
        ? 0n
        : (1n << 63n) | BigInt(value.functionIndex + 1);
      return address === 0n
        ? { initialized: true, status: 'null', address }
        : { initialized: true, status: 'function', address };
    }

    let address = 0n;
    for (let index = 0; index < size; index++) {
      const byte = member.root.representation.get(member.byteOffset + index) ?? (member.zeroInitialized ? 0 : undefined);
      if (byte === undefined) return { initialized: true, status: 'unmapped' };
      address |= BigInt(byte) << BigInt(index * 8);
    }
    if (address === 0n) return { initialized: true, status: 'null', address };
    if (isFunction(pointedToType(member.type) ?? 'void') &&
        (this.functionRepresentations.has(address) || (address & (1n << 63n)) !== 0n)) {
      return { initialized: true, status: 'function', address };
    }
    return { initialized: true, status: 'unmapped', address };
  }

  private inspectArithmeticRepresentation(
    root: AllocationRoot,
    type: CType,
    byteOffset: number,
    size: number,
    nodeInitialized: boolean,
    zeroInitialized: boolean,
    at: Location,
  ): { readonly initialized: boolean; readonly value?: ObjectScalarValue } {
    let fullyRepresented = true;
    for (let index = 0; index < size; index++) {
      if (!root.representation.has(byteOffset + index)) {
        fullyRepresented = false;
        break;
      }
    }
    if (!nodeInitialized && !zeroInitialized && !fullyRepresented) return { initialized: false };
    const bytes = Array.from({ length: size }, (_, index) =>
      root.representation.get(byteOffset + index) ?? (zeroInitialized ? 0 : undefined));
    if (bytes.some((byte) => byte === undefined)) return { initialized: false };
    return { initialized: true, value: this.decodeScalar(type, bytes as number[], at) };
  }

  /** Report allocation metadata only; this flag does not mediate C write semantics. */
  isReadOnly(ref: ObjectReference, at: Location): boolean {
    return this.nodeFor(ref, at).readOnly === true;
  }

  /**
   * Read the stored bytes of an initialized string literal without creating
   * element objects or turning a missing representation into a C read error.
   */
  inspectStringLiteral(ref: ObjectReference): readonly number[] | undefined {
    const node = this.records.get(ref.objectId);
    if (!node || node.allocationId !== ref.allocationId || !node.alive) return undefined;
    const root = this.roots.get(node.allocationId);
    const array = root ? arrayType(root.type) : undefined;
    if (!root?.alive || node.id !== root.id || root.duration !== 'string-literal' ||
        !array || unqualifiedType(array.element) !== 'char' || array.length === null ||
        array.length !== root.size) return undefined;

    const bytes: number[] = [];
    for (let offset = 0; offset < root.size; offset++) {
      const byte = root.representation.get(root.byteOffset + offset);
      if (byte === undefined) return undefined;
      bytes.push(byte);
    }
    if (bytes.at(-1) !== 0) return undefined;
    return Object.freeze(bytes);
  }

  write(ref: ObjectReference, value: CValue, at: Location, initializing = false): CValue {
    const node = this.nodeFor(ref, at);
    this.ensureWritable(node, at, initializing);
    if (node.byteView) {
      if (!compatibleType(unqualifiedType(node.type), unqualifiedType(value.type))) failure('TYPE_ERROR', 'The value does not match the byte view’s char type.', at);
      if (!isCharacterType(node.type) || typeof value.value !== 'bigint') failure('TYPE_ERROR', 'The byte view requires an integer char value.', at);
      const root = this.rootFor(node, at);
      const byte = Number(BigInt.asUintN(8, value.value));
      this.clearPointerProvenance(root, node.byteOffset, node.byteOffset + 1);
      this.invalidatePointerObjectCaches(root, node.byteOffset, node.byteOffset + 1);
      root.representation.set(node.byteOffset, byte);
      node.value = BigInt.asIntN(8, BigInt(byte));
      node.initialized = true;
      return { type: unqualifiedType(node.type), value: node.value! };
    }
    this.activateContainingUnions(node, at);
    const bitField = this.bitFieldFor(node, at);
    if (bitField) {
      if (!compatibleType(unqualifiedType(node.type), unqualifiedType(value.type)) || typeof value.value !== 'bigint') {
        failure('TYPE_ERROR', 'Bit-field assignment requires a compatible integer value.', at);
      }
      const assigned = this.writeBitField(node, bitField.member.bitField!, value.value, at);
      return { type: unqualifiedType(node.type), value: assigned };
    }
    if (isArray(node.type)) failure('INVALID_LVALUE', 'An array cannot be assigned as a complete object.', at);
    if (isAggregate(node.type)) {
      if (!compatibleType(unqualifiedType(node.type), unqualifiedType(value.type)) || typeof value.value !== 'object' || value.value === null || value.value.kind !== 'aggregate-value') {
        failure('TYPE_ERROR', 'Aggregate assignment requires a value of the same type.', at);
      }
      this.restore(node, value.value.snapshot, at);
      this.recordEffectiveType(node, node.type, at);
      return { type: unqualifiedType(node.type), value: value.value };
    }
    if (!compatibleType(unqualifiedType(node.type), unqualifiedType(value.type))) failure('TYPE_ERROR', 'The value is incompatible with the object type.', at);
    if (typeof value.value === 'object' && value.value !== null && value.value.kind === 'aggregate-value') {
      failure('TYPE_ERROR', 'An aggregate value cannot be stored in a scalar object.', at);
    }
    node.value = value.value as ObjectScalarValue;
    node.initialized = true;
    this.writeRepresentation(node, node.value, at);
    this.recordEffectiveType(node, node.type, at);
    return { type: unqualifiedType(node.type), value: node.value };
  }

  zeroInitialize(ref: ObjectReference, at: Location): void {
    const node = this.nodeFor(ref, at);
    this.ensureWritable(node, at, true);
    if (isArray(node.type) || isAggregate(node.type)) {
      this.clearRepresentation(node, at);
      node.initialized = true;
      node.zeroInitialized = true;
      if (isAggregate(node.type)) {
        const definition = this.aggregate(node.type, at);
        node.activeMember = definition.kind === 'union' ? 0 : undefined;
      }
      return;
    }
    node.value = this.zeroValue(node.type, at);
    node.initialized = true;
    this.writeRepresentation(node, node.value, at);
  }

  private allocateRoot(
    type: CType,
    size: number,
    duration: StorageDuration,
    at: Location,
    raw: boolean,
    reservedNextBytes?: number,
    heapReservation?: AddressReservation,
    ignoredHeapFirstSlot?: bigint,
    options: MemoryAllocationOptions = {},
  ): ObjectReference {
    const nextBytes = reservedNextBytes ?? this.nextAllocationByteCount(size, at);
    const alignment = options.alignment ?? Number(ALLOCATION_ALIGNMENT);
    this.validateAlignment(alignment, at);
    const reservation = duration === 'heap'
      ? heapReservation ?? failure('ENGINE_INTERNAL_ERROR', 'Missing selected address for a heap allocation.', at)
      : this.chooseSessionAddress(size, duration, alignment) ?? this.failRegionExhaustion(size, duration, at);
    const virtualBase = reservation.virtualBase;
    const region = this.regionForDuration(duration);
    if (virtualBase < region.start || reservation.endExclusive > region.endExclusive ||
        virtualBase + BigInt(size) + BigInt(VIRTUAL_MEMORY_LAYOUT.guardBytes) > reservation.endExclusive ||
        virtualBase % BigInt(alignment) !== 0n) {
      failure('ENGINE_INTERNAL_ERROR', 'The virtual reservation is outside its region or violates alignment or guard requirements.', at);
    }
    if (duration === 'heap') {
      if (reservation.heapSlotCount === undefined) {
        failure('ENGINE_INTERNAL_ERROR', 'Missing reserved size for a heap allocation.', at);
      }
      const firstHeapSlot = (virtualBase - VIRTUAL_HEAP_LAYOUT.start) / ALLOCATION_ALIGNMENT;
      const endHeapSlot = firstHeapSlot + reservation.heapSlotCount;
      for (const [occupiedStart, occupiedEnd] of this.heapExtents) {
        if (occupiedStart === ignoredHeapFirstSlot) continue;
        if (firstHeapSlot < occupiedEnd && occupiedStart < endHeapSlot) {
          failure('ENGINE_INTERNAL_ERROR', 'The allocator selected an occupied heap range.', at);
        }
      }
    } else {
      const extents = this.extentsForDuration(duration);
      for (const [occupiedStart, occupiedEnd] of extents) {
        if (virtualBase < occupiedEnd && occupiedStart < reservation.endExclusive) {
          failure('ENGINE_INTERNAL_ERROR', 'The allocator selected an occupied object range.', at);
        }
      }
    }
    const id = this.nextObjectId++;
    const objectType = unqualifiedType(type);
    const root: AllocationRoot = {
      id, allocationId: id, type: objectType, byteOffset: 0, size, duration, rawAllocation: raw, alignment,
      virtualBase,
      representation: new Map(), pointerValues: new Map(), pointerObjects: new Set(), effectiveTypes: [], constRanges: [],
      ...(duration === 'heap' ? { heapSlotCount: reservation.heapSlotCount! } : {}),
      initialized: false, zeroInitialized: false, alive: true, children: new Map(),
      ...(options.isConst || qualifiersOf(type).const ? { readOnly: true } : {}),
    };
    if (root.readOnly && size > 0) root.constRanges.push({ start: 0, end: size });
    else this.collectConstRanges(root, objectType, 0, at);
    if (this.retainPointerAllocationAddresses) this.pointerAllocationAddresses.set(id, virtualBase);
    if (isPointer(type)) root.pointerObjects.add(root);
    this.records.set(id, root);
    this.roots.set(id, root);
    if (duration === 'heap') {
      const firstHeapSlot = (virtualBase - VIRTUAL_HEAP_LAYOUT.start) / ALLOCATION_ALIGNMENT;
      this.heapExtents.set(firstHeapSlot, firstHeapSlot + reservation.heapSlotCount!);
    } else this.extentsForDuration(duration).set(virtualBase, reservation.endExclusive);
    this.liveBytes = nextBytes;
    this.metrics.peakMemoryBytes = Math.max(this.metrics.peakMemoryBytes, this.liveBytes);
    return this.reference(root);
  }

  private nextAllocationByteCount(size: number, at: Location): number {
    const nextBytes = this.liveBytes + size;
    enforceLimit('maxMemoryBytes', nextBytes, this.maxMemoryBytes, at);
    return nextBytes;
  }

  private validateAlignment(alignment: number, at: Location): void {
    if (!Number.isSafeInteger(alignment) || alignment < 1 || alignment > 65536 || (alignment & (alignment - 1)) !== 0) {
      failure('INVALID_ALIGNMENT', 'Alignment must be a power of two between 1 and 65536.', at);
    }
  }

  private collectConstRanges(root: AllocationRoot, type: CType, offset: number, at: Location): void {
    const size = sizeOfType(type, this.aggregates, at);
    if (qualifiersOf(type).const) {
      root.constRanges.push({ start: offset, end: offset + size });
      return;
    }
    const unqualified = unqualifiedType(type);
    const array = arrayType(unqualified);
    if (array) {
      if (array.length === null) return;
      const stride = sizeOfType(array.element, this.aggregates, at);
      for (let index = 0; index < array.length; index++) {
        this.collectConstRanges(root, array.element, offset + index * stride, at);
      }
      return;
    }
    const aggregate = aggregateType(unqualified);
    if (!aggregate) return;
    const definition = this.aggregate(aggregate, at);
    for (const member of definition.members) {
      if (member.bitField) {
        if (!qualifiersOf(member.type).const || member.bitField.width <= 0) continue;
        const bits = member.bitField;
        const mask = ((1n << BigInt(bits.width)) - 1n) << BigInt(bits.bitOffset);
        root.constRanges.push({
          start: offset + bits.storageUnitOffset,
          end: offset + bits.storageUnitOffset + bits.storageUnitSize,
          bitMask: mask,
        });
      } else if (member.flexibleArray) {
        const flexible = arrayType(member.type);
        if (!flexible || flexible.length !== null) continue;
        const elementSize = sizeOfType(flexible.element, this.aggregates, member.location);
        const start = offset + member.offset;
        const capacity = Math.max(0, root.size - start);
        const count = Math.floor(capacity / elementSize);
        for (let index = 0; index < count; index++) {
          this.collectConstRanges(root, flexible.element, start + index * elementSize, member.location);
        }
      } else {
        this.collectConstRanges(root, member.type, offset + member.offset, member.location);
      }
    }
  }

  private reservationSlotCount(size: number): bigint {
    const bytesWithGuard = BigInt(size) + BigInt(VIRTUAL_MEMORY_LAYOUT.guardBytes);
    return (bytesWithGuard + ALLOCATION_ALIGNMENT - 1n) / ALLOCATION_ALIGNMENT;
  }

  private regionForDuration(duration: StorageDuration): { readonly start: bigint; readonly endExclusive: bigint } {
    if (duration === 'heap') return VIRTUAL_MEMORY_LAYOUT.heapAddressRange;
    if (duration === 'automatic' || duration === 'compound-literal') return VIRTUAL_MEMORY_LAYOUT.stackAddressRange;
    return VIRTUAL_MEMORY_LAYOUT.staticAddressRange;
  }

  private extentsForDuration(duration: Exclude<StorageDuration, 'heap'>): Map<bigint, bigint> {
    return duration === 'automatic' || duration === 'compound-literal' ? this.stackExtents : this.staticExtents;
  }

  /** Find the lowest fitting aligned extent by inspecting live allocations, not reserved bytes. */
  private chooseSessionAddress(size: number, duration: Exclude<StorageDuration, 'heap'>, alignment: number): AddressReservation | undefined {
    const region = this.regionForDuration(duration);
    const slotCount = this.reservationSlotCount(size);
    const reservedBytes = slotCount * ALLOCATION_ALIGNMENT;
    const alignmentBytes = BigInt(alignment);
    const alignUp = (address: bigint): bigint => ((address + alignmentBytes - 1n) / alignmentBytes) * alignmentBytes;
    const occupied = [...this.extentsForDuration(duration).entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    let candidate = alignUp(region.start);
    for (const [start, end] of occupied) {
      candidate = alignUp(candidate);
      if (candidate + reservedBytes <= start) return { virtualBase: candidate, endExclusive: candidate + reservedBytes };
      if (end > candidate) candidate = alignUp(end);
    }
    candidate = alignUp(candidate);
    if (candidate + reservedBytes <= region.endExclusive) {
      return { virtualBase: candidate, endExclusive: candidate + reservedBytes };
    }
    return undefined;
  }

  private failRegionExhaustion(size: number, duration: Exclude<StorageDuration, 'heap'>, at: Location): never {
    const regionName = duration === 'automatic' || duration === 'compound-literal' ? 'Stack' : 'Static';
    const code = regionName === 'Stack' ? 'STACK_ADDRESS_SPACE_EXHAUSTED' : 'STATIC_ADDRESS_SPACE_EXHAUSTED';
    failure(code, `Virtual region ${regionName} has no space to reserve ${size} C bytes and its guard.`, at);
  }

  /** Choose a random aligned start with bounded probes, then scan live extents once as fallback. */
  private heapReservationAt(
    size: number,
    virtualBase: bigint,
    ignoredFirstSlot?: bigint,
  ): AddressReservation | undefined {
    const heapRange = VIRTUAL_MEMORY_LAYOUT.heapAddressRange;
    const totalSlots = (heapRange.endExclusive - heapRange.start) / ALLOCATION_ALIGNMENT;
    const slotCount = this.reservationSlotCount(size);
    if (virtualBase < heapRange.start || virtualBase % ALLOCATION_ALIGNMENT !== 0n) return undefined;
    const first = (virtualBase - heapRange.start) / ALLOCATION_ALIGNMENT;
    if (first + slotCount > totalSlots) return undefined;
    const end = first + slotCount;
    for (const [occupiedStart, occupiedEnd] of this.heapExtents) {
      if (occupiedStart === ignoredFirstSlot) continue;
      if (first < occupiedEnd && occupiedStart < end) return undefined;
    }
    return {
      virtualBase,
      endExclusive: heapRange.start + end * ALLOCATION_ALIGNMENT,
      heapSlotCount: slotCount,
    };
  }

  private chooseHeapAddress(
    size: number, at: Location, ignoredFirstSlot?: bigint, alignment = Number(ALLOCATION_ALIGNMENT),
  ): AddressReservation | undefined {
    const heapRange = VIRTUAL_MEMORY_LAYOUT.heapAddressRange;
    const totalSlots = (heapRange.endExclusive - heapRange.start) / ALLOCATION_ALIGNMENT;
    const slotCount = this.reservationSlotCount(size);
    if (slotCount > totalSlots) return undefined;
    const latestStart = totalSlots - slotCount;
    const alignmentBytes = BigInt(alignment);
    const alignSlot = (slot: bigint): bigint => {
      if (alignment <= Number(ALLOCATION_ALIGNMENT)) return slot;
      const address = heapRange.start + slot * ALLOCATION_ALIGNMENT;
      const remainder = address % alignmentBytes;
      return remainder === 0n ? slot : slot + (alignmentBytes - remainder) / ALLOCATION_ALIGNMENT;
    };
    const randomStart = (): bigint => {
      const random = this.heapAddressRandom();
      if (!Number.isFinite(random) || random < 0 || random >= 1) {
        failure('ENGINE_INTERNAL_ERROR', 'The heap address generator produced an invalid value.', at);
      }
      // Slot counts in the configured heap region stay exactly representable as Number.
      return alignSlot(BigInt(Math.floor(random * Number(latestStart + 1n))));
    };
    const occupiedExtents = [...this.heapExtents.entries()]
      .filter(([start]) => start !== ignoredFirstSlot);
    const fits = (first: bigint): boolean => {
      const end = first + slotCount;
      for (const [occupiedStart, occupiedEnd] of occupiedExtents) {
        if (first < occupiedEnd && occupiedStart < end) return false;
      }
      return true;
    };
    for (let attempt = 0; attempt < 64; attempt++) {
      const first = randomStart();
      if (fits(first)) {
        const virtualBase = heapRange.start + first * ALLOCATION_ALIGNMENT;
        return { virtualBase, endExclusive: heapRange.start + (first + slotCount) * ALLOCATION_ALIGNMENT, heapSlotCount: slotCount };
      }
    }

    // A sorted list of extents bounds this fallback by live allocation count,
    // rather than searching the enormous virtual address interval one slot at a time.
    const occupied = occupiedExtents
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    let candidate = alignSlot(0n);
    for (const [start, end] of occupied) {
      if (candidate <= latestStart && candidate + slotCount <= start) {
        const virtualBase = heapRange.start + candidate * ALLOCATION_ALIGNMENT;
        return { virtualBase, endExclusive: heapRange.start + (candidate + slotCount) * ALLOCATION_ALIGNMENT, heapSlotCount: slotCount };
      }
      if (end > candidate) candidate = alignSlot(end);
    }
    if (candidate <= latestStart) {
      const virtualBase = heapRange.start + candidate * ALLOCATION_ALIGNMENT;
      return { virtualBase, endExclusive: heapRange.start + (candidate + slotCount) * ALLOCATION_ALIGNMENT, heapSlotCount: slotCount };
    }
    return undefined;
  }

  private invalidateRoot(id: number, at: Location): void {
    const root = this.roots.get(id);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The object lifetime has already ended.', at);
    root.alive = false;
    this.liveBytes -= root.size;
    const pending: RuntimeObject[] = [root];
    while (pending.length) {
      const node = pending.pop()!;
      pending.push(...node.children.values());
      node.alive = false;
      node.children.clear();
      this.records.delete(node.id);
    }
    for (const view of this.rawViews.get(id)?.values() ?? []) {
      view.alive = false;
      view.children.clear();
      this.records.delete(view.id);
    }
    this.rawViews.delete(id);
    root.representation.clear();
    root.pointerValues.clear();
    root.pointerObjects.clear();
    this.roots.delete(id);
    if (root.duration === 'heap') {
      const firstHeapSlot = (root.virtualBase - VIRTUAL_HEAP_LAYOUT.start) / ALLOCATION_ALIGNMENT;
      this.heapExtents.delete(firstHeapSlot);
    } else this.extentsForDuration(root.duration).delete(root.virtualBase);
    for (const [address, pointer] of this.formattedObjectPointers) {
      if (pointer.allocationId === id) this.formattedObjectPointers.delete(address);
    }
  }

  private nodeFor(ref: ObjectReference, at: Location): RuntimeObject {
    const node = this.records.get(ref.objectId);
    if (!node || node.allocationId !== ref.allocationId) failure('INACTIVE_OBJECT', 'The reference does not identify a live object.', at);
    const root = this.roots.get(node.allocationId);
    if (!node.alive || !root?.alive) failure('INACTIVE_OBJECT', 'The object lifetime has ended.', at);
    return node;
  }

  private directStructMember(ref: ObjectReference, memberIndex: number, at: Location): {
    readonly parent: RuntimeObject;
    readonly root: AllocationRoot;
    readonly type: CType;
    readonly byteOffset: number;
    readonly zeroInitialized: boolean;
  } {
    const parent = this.nodeFor(ref, at);
    const parentAggregate = aggregateType(parent.type);
    if (!parentAggregate) failure('INVALID_MEMBER_ACCESS', 'Member inspection requires a struct.', at);
    const definition = this.aggregate(parentAggregate, at);
    if (definition.kind !== 'struct') failure('TYPE_ERROR', 'Visible-member inspection only supports structs.', at);
    const member = definition.members[memberIndex];
    if (!member) failure('UNKNOWN_MEMBER', `No member exists at index ${memberIndex}.`, at);
    const child = parent.children.get(memberIndex);
    return {
      parent,
      root: this.rootFor(parent, at),
      type: member.type,
      byteOffset: parent.byteOffset + member.offset,
      zeroInitialized: child ? this.hasZeroInitializedAncestor(child) : this.hasZeroInitializedAncestor(parent),
    };
  }

  private child(parent: RuntimeObject, index: number, at: Location, member?: AggregateDefinition['members'][number]): ObjectReference {
    let type: CType;
    let byteOffset: number;
    let memberIndex: number | undefined;
    const parentArray = arrayType(parent.type);
    const parentAggregate = aggregateType(parent.type);
    if (parentArray) {
      if (parentArray.length === null || index < 0 || index >= parentArray.length) failure('ARRAY_BOUNDS', 'The index is outside the array bounds.', at);
      type = parentArray.element;
      byteOffset = parent.byteOffset + index * sizeOfType(type, this.aggregates, at);
    } else if (parentAggregate) {
      const definition = this.aggregate(parentAggregate, at);
      const selected = member ?? definition.members[index];
      if (!selected) failure('UNKNOWN_MEMBER', `No member exists at index ${index}.`, at);
      type = selected.type;
      byteOffset = parent.byteOffset + selected.offset;
      memberIndex = selected.index;
      index = selected.index;
      if (selected.flexibleArray) {
        const flexible = arrayType(selected.type);
        if (!flexible || flexible.length !== null) failure('ENGINE_INTERNAL_ERROR', 'The flexible member lost its incomplete array type.', at);
        const elementSize = sizeOfType(flexible.element, this.aggregates, at);
        const capacity = Math.max(0, this.rootFor(parent, at).size - byteOffset);
        type = arrayOf(flexible.element, Math.floor(capacity / elementSize));
      }
    } else failure('INVALID_SUBOBJECT', 'The object contains no indexable subobjects.', at);

    let node = parent.children.get(index);
    if (node && node.type !== type && !sameType(node.type, type)) failure('ENGINE_INTERNAL_ERROR', 'The index reused a subobject with an incompatible type.', at);
    if (!node) {
      const id = this.nextObjectId++;
      const inheritedZero = parent.zeroInitialized;
      node = {
        id, allocationId: parent.allocationId, type, byteOffset,
        size: sizeOfType(type, this.aggregates, at), duration: parent.duration,
        parentId: parent.id, childIndex: index, memberIndex, rawAllocation: false,
        ...(parent.initializationShadow?.children?.[index] === undefined
          ? {}
          : { initializationShadow: parent.initializationShadow.children[index] }),
        initialized: false, zeroInitialized: false, alive: true, children: new Map(),
      };
      if (inheritedZero) {
        if (isArray(type) || isAggregate(type)) {
          node.zeroInitialized = true;
          if (isAggregate(type)) {
            const definition = this.aggregate(type, at);
            if (definition.kind === 'union') node.activeMember = 0;
          }
        }
        else { node.value = this.zeroValue(type, at); node.initialized = true; }
      }
      parent.children.set(index, node);
      this.records.set(id, node);
      if (isPointer(type)) this.roots.get(node.allocationId)?.pointerObjects.add(node);
      if (node.initializationShadow) this.applyInitializationSnapshot(node, node.initializationShadow, at);
    }
    if (memberIndex !== undefined && parentAggregate && this.aggregate(parentAggregate, at).kind === 'union' && parent.activeMember === undefined) {
      // A union without an initializer has no active member; creating its lvalue does not select one.
    }
    return this.reference(node, parentArray ? {
      arrayId: parent.id,
      arrayIndex: index,
      arrayLength: parentArray.length!,
      boundsStart: parent.byteOffset,
      boundsEnd: parent.byteOffset + parent.size,
    } : { parentId: parent.id, memberIndex });
  }

  private reference(node: RuntimeObject, extra: Partial<ObjectReference> = {}): ObjectReference {
    return {
      objectId: node.id, allocationId: node.allocationId, byteOffset: node.byteOffset, type: node.type,
      ...extra,
    };
  }

  private locate(root: AllocationRoot, byteOffset: number, type: CType, at: Location): RuntimeObject {
    if (isCharacterType(type)) {
      const key = `${byteOffset}:${this.typeKey(type)}`;
      const cached = this.rawViews.get(root.id)?.get(key);
      if (cached) return cached;
      const view: RuntimeObject = {
        id: this.nextObjectId++, allocationId: root.id, type, byteOffset, size: 1,
        duration: root.duration, parentId: root.id, rawView: true, rawAllocation: false, byteView: true,
        initialized: false, zeroInitialized: false, alive: true, children: new Map(),
      };
      let views = this.rawViews.get(root.id);
      if (!views) { views = new Map(); this.rawViews.set(root.id, views); }
      views.set(key, view);
      this.records.set(view.id, view);
      if (isPointer(type)) root.pointerObjects.add(view);
      return view;
    }
    if (root.rawAllocation) {
      const size = sizeOfType(type, this.aggregates, at);
      if (byteOffset < root.byteOffset || byteOffset + size > root.byteOffset + root.size) failure('POINTER_BOUNDS', 'Access exceeds the reserved block.', at);
      const key = `${byteOffset}:${this.typeKey(type)}`;
      const cached = this.rawViews.get(root.id)?.get(key);
      if (cached) return cached;
      const view: RuntimeObject = {
        id: this.nextObjectId++, allocationId: root.id, type, byteOffset, size,
        duration: 'heap', parentId: root.id, rawView: true, rawAllocation: false,
        initialized: false, zeroInitialized: false, alive: true, children: new Map(),
      };
      let views = this.rawViews.get(root.id);
      if (!views) { views = new Map(); this.rawViews.set(root.id, views); }
      views.set(key, view);
      this.records.set(view.id, view);
      if (isPointer(type)) root.pointerObjects.add(view);
      const effective = root.effectiveTypes
        .filter((range) => range.start === byteOffset && range.end === byteOffset + size && sameType(range.type, type))
        .at(-1);
      if (effective?.initialization) this.applyInitializationSnapshot(view, effective.initialization, at);
      return view;
    }
    const pending: RuntimeObject[] = [root];
    while (pending.length) {
      const current = pending.pop()!;
      if (current.byteOffset === byteOffset &&
          sameType(unqualifiedType(current.type), unqualifiedType(type))) return current;
      const currentArray = arrayType(current.type);
      const currentAggregate = aggregateType(current.type);
      if (currentArray) {
        const stride = sizeOfType(currentArray.element, this.aggregates, at);
        const delta = byteOffset - current.byteOffset;
        if (delta < 0 || delta >= current.size || currentArray.length === null) continue;
        // A nested element may start at an offset inside this array element
        // (for example matrix[0][1]); descend through the containing row.
        const index = Math.floor(delta / stride);
        const child = this.child(current, index, at);
        pending.push(this.records.get(child.objectId)!);
      } else if (currentAggregate) {
        const definition = this.aggregate(currentAggregate, at);
        const candidates = definition.members.filter((member) => {
          const start = current.byteOffset + member.offset;
          const memberSize = member.bitField
            ? member.bitField.storageUnitSize
            : member.flexibleArray
              ? Math.max(0, root.byteOffset + root.size - start)
              : sizeOfType(member.type, this.aggregates, at);
          const end = start + memberSize;
          return byteOffset >= start && byteOffset < end;
        });
        candidates.sort((a, b) => Number(a.index !== current.activeMember) - Number(b.index !== current.activeMember));
        for (let index = candidates.length - 1; index >= 0; index--) {
          const child = this.child(current, candidates[index].index, at, candidates[index]);
          pending.push(this.records.get(child.objectId)!);
        }
      }
    }
    failure('INVALID_POINTER_ACCESS', 'The address does not correspond to an object of the pointed-to type.', at);
  }

  private readSnapshot(node: RuntimeObject, at: Location): ObjectSnapshot {
    const snapshot: {
      initialized: boolean; value?: ObjectScalarValue; zeroInitialized?: boolean;
      children?: Record<number, ObjectSnapshot>; activeMember?: number;
    } = { initialized: node.initialized };
    if (node.initialized && isScalar(node.type)) {
      const bitField = this.bitFieldFor(node, at);
      snapshot.value = bitField ? this.readBitField(node, bitField.member.bitField!, at) : this.readScalar(node, at);
    }
    if (node.zeroInitialized) snapshot.zeroInitialized = true;
    if (node.activeMember !== undefined) snapshot.activeMember = node.activeMember;
    if (node.children.size) {
      const children: Record<number, ObjectSnapshot> = {};
      const aggregate = aggregateType(node.type);
      const definition = aggregate ? this.aggregate(aggregate, at) : undefined;
      const activeUnion = definition?.kind === 'union' ? node.activeMember : undefined;
      for (const [index, child] of node.children) {
        if (activeUnion !== undefined && index !== activeUnion) continue;
        if (definition?.flexibleMemberIndex === index) continue;
        children[index] = this.readSnapshot(child, at);
      }
      snapshot.children = children;
    }
    return snapshot;
  }

  private snapshot(node: RuntimeObject, at: Location): ObjectSnapshot { return this.readSnapshot(node, at); }

  private copyInitializationSnapshot(node: RuntimeObject, at: Location): ObjectSnapshot {
    const snapshot: {
      initialized: boolean; zeroInitialized?: boolean; children?: Record<number, ObjectSnapshot>; activeMember?: number;
    } = { initialized: node.initialized };
    if (node.zeroInitialized) snapshot.zeroInitialized = true;
    if (node.activeMember !== undefined) snapshot.activeMember = node.activeMember;
    if (node.children.size) {
      const children: Record<number, ObjectSnapshot> = {};
      const aggregate = aggregateType(node.type);
      const definition = aggregate ? this.aggregate(aggregate, at) : undefined;
      for (const [index, child] of node.children) {
        if (definition?.kind === 'union' && node.activeMember !== undefined && index !== node.activeMember) continue;
        if (definition?.flexibleMemberIndex === index) continue;
        children[index] = this.copyInitializationSnapshot(child, at);
      }
      snapshot.children = children;
    }
    return snapshot;
  }

  private applyInitializationSnapshot(node: RuntimeObject, snapshot: ObjectSnapshot, at: Location): void {
    if (node.initializationShadowApplied) return;
    node.initializationShadow = snapshot;
    node.initializationShadowApplied = true;
    node.initialized = snapshot.initialized;
    node.value = undefined;
    node.zeroInitialized = !!snapshot.zeroInitialized;
    node.activeMember = snapshot.activeMember;
    for (const [indexText, childSnapshot] of Object.entries(snapshot.children ?? {})) {
      const index = Number(indexText);
      const aggregate = aggregateType(node.type);
      if (aggregate && this.aggregate(aggregate, at).flexibleMemberIndex === index) continue;
      const child = this.nodeFor(this.child(node, index, at), at);
      this.applyInitializationSnapshot(child, childSnapshot, at);
    }
  }

  private applyInitializationShadows(root: AllocationRoot, at: Location): void {
    const views = this.rawViews.get(root.allocationId);
    if (!views) return;
    for (const range of root.effectiveTypes) {
      if (!range.initialization) continue;
      const view = [...views.values()].find((candidate) => candidate.alive && candidate.byteOffset === range.start &&
        candidate.size === range.end - range.start && sameType(candidate.type, range.type));
      if (view) this.applyInitializationSnapshot(view, range.initialization, at);
    }
  }

  private restore(node: RuntimeObject, snapshot: ObjectSnapshot, at: Location): void {
    this.clearRepresentation(node, at);
    for (const child of node.children.values()) this.resetTree(child, !!snapshot.zeroInitialized);
    node.initialized = snapshot.initialized;
    node.value = snapshot.value;
    node.zeroInitialized = !!snapshot.zeroInitialized;
    node.activeMember = snapshot.activeMember;
    for (const [indexText, childSnapshot] of Object.entries(snapshot.children ?? {})) {
      const index = Number(indexText);
      const aggregate = aggregateType(node.type);
      if (aggregate && this.aggregate(aggregate, at).flexibleMemberIndex === index) continue;
      const childRef = this.child(node, index, at);
      const child = this.nodeFor(childRef, at);
      this.restore(child, childSnapshot, at);
    }
    if (isScalar(node.type) && node.initialized && node.value !== undefined) {
      const bitField = this.bitFieldFor(node, at);
      if (bitField) this.writeBitField(node, bitField.member.bitField!, node.value, at);
      else this.writeRepresentation(node, node.value, at);
    }
  }

  private activateContainingUnions(node: RuntimeObject, at: Location): void {
    let current = node;
    while (current.parentId !== undefined) {
      const parent = this.records.get(current.parentId);
      if (!parent) break;
      if (aggregateType(parent.type) && this.aggregate(parent.type, at).kind === 'union' && current.memberIndex !== undefined) {
        if (parent.activeMember !== current.memberIndex) {
          parent.zeroInitialized = false;
          parent.activeMember = current.memberIndex;
          parent.children.set(current.memberIndex, current);
        }
      }
      current = parent;
    }
  }

  private resetTree(node: RuntimeObject, zeroInitialized: boolean): void {
    node.initialized = false;
    node.value = undefined;
    node.zeroInitialized = zeroInitialized;
    node.activeMember = undefined;
    node.initializationShadow = undefined;
    node.initializationShadowApplied = false;
    const aggregate = aggregateType(node.type);
    if (zeroInitialized && aggregate) {
      const definition = this.aggregates.find((item) => item.id === aggregate.id);
      if (definition?.kind === 'union') node.activeMember = 0;
    }
    for (const child of node.children.values()) this.resetTree(child, zeroInitialized);
  }

  private ensureWritable(node: RuntimeObject, at: Location, initializing = false): void {
    if (node.duration === 'string-literal') failure('STRING_LITERAL_MODIFICATION', 'Modifying a string literal is undefined behavior in C11.', at);
    if (initializing) return;
    const root = this.rootFor(node, at);
    const field = this.bitFieldFor(node, at)?.member.bitField;
    const start = node.byteOffset;
    const end = start + node.size;
    const writeMask = field
      ? ((1n << BigInt(field.width)) - 1n) << BigInt(field.bitOffset)
      : undefined;
    if (root.constRanges.some((range) => range.start < end && start < range.end &&
      (range.bitMask === undefined || writeMask === undefined || (range.bitMask & writeMask) !== 0n))) {
      failure('CONST_OBJECT_MODIFICATION', 'Modifying an object defined with const is undefined behavior in C11.', at);
    }
  }

  private ensureEffectiveType(node: RuntimeObject, at: Location): void {
    const root = this.rootFor(node, at);
    if (!root.rawAllocation || node.byteView || isCharacterType(node.type)) return;
    const start = node.byteOffset;
    const end = start + node.size;
    const candidates = root.effectiveTypes
      .map((range, index) => ({ range, index }))
      .filter(({ range }) => range.start <= start && range.end >= end)
      .sort((left, right) => {
        const leftSize = left.range.end - left.range.start;
        const rightSize = right.range.end - right.range.start;
        return leftSize - rightSize || right.index - left.index;
      });
    if (candidates.some(({ range }) => this.effectiveTypeCovers(range.type, range.start, range.end, start, end, node.type, at))) return;
    if (root.effectiveTypes.some((range) => range.start < end && start < range.end)) {
      failure('EFFECTIVE_TYPE_VIOLATION', 'Access is incompatible with the effective type established in heap storage.', at);
    }
  }

  private effectiveTypeCovers(
    effectiveType: CType,
    effectiveStart: number,
    effectiveEnd: number,
    accessStart: number,
    accessEnd: number,
    accessType: CType,
    at: Location,
  ): boolean {
    if (accessStart === effectiveStart && accessEnd === effectiveEnd) {
      return this.typesMayAlias(effectiveType, accessType, at);
    }
    const array = arrayType(effectiveType);
    if (array) {
      const elementSize = sizeOfType(array.element, this.aggregates, at);
      const length = array.length ?? Math.floor((effectiveEnd - effectiveStart) / elementSize);
      const first = Math.max(0, Math.floor((accessStart - effectiveStart) / elementSize));
      const last = Math.min(length - 1, Math.floor((accessEnd - 1 - effectiveStart) / elementSize));
      for (let index = first; index <= last; index++) {
        const elementStart = effectiveStart + index * elementSize;
        if (accessStart >= elementStart && accessEnd <= elementStart + elementSize &&
            this.effectiveTypeCovers(array.element, elementStart, elementStart + elementSize, accessStart, accessEnd, accessType, at)) return true;
      }
      return false;
    }
    const aggregate = aggregateType(effectiveType);
    if (!aggregate) return false;
    const definition = this.aggregate(aggregate, at);
    for (const member of definition.members) {
      const memberStart = effectiveStart + member.offset;
      const memberArray = member.flexibleArray ? arrayType(member.type) : undefined;
      const memberSize = member.bitField
        ? member.bitField.storageUnitSize
        : memberArray
          ? Math.max(0, effectiveEnd - memberStart)
          : sizeOfType(member.type, this.aggregates, member.location);
      if (accessStart < memberStart || accessEnd > memberStart + memberSize) continue;
      const memberType = memberArray
        ? arrayOf(memberArray.element, Math.floor(memberSize / sizeOfType(memberArray.element, this.aggregates, member.location)))
        : member.type;
      if (this.effectiveTypeCovers(memberType, memberStart, memberStart + memberSize, accessStart, accessEnd, accessType, at)) return true;
    }
    return false;
  }

  private typesMayAlias(left: CType, right: CType, at: Location, visited = new Set<string>()): boolean {
    left = unqualifiedType(left);
    right = unqualifiedType(right);
    if (sameType(left, right)) return true;
    if (compatibleType(left, right)) return true;
    if (isCharacterType(right)) return true;
    const leftName = typeof left === 'string' ? left : undefined;
    const rightName = typeof right === 'string' ? right : undefined;
    if (leftName && rightName &&
        (CORRESPONDING_UNSIGNED[leftName] === rightName || CORRESPONDING_SIGNED[leftName] === rightName)) return true;
    const key = `${this.typeKey(left)}:${this.typeKey(right)}`;
    if (visited.has(key)) return false;
    visited.add(key);
    return this.aggregateContainsType(left, right, at, visited) || this.aggregateContainsType(right, left, at, visited);
  }

  private aggregateContainsType(container: CType, target: CType, at: Location, visited: Set<string>): boolean {
    const array = arrayType(container);
    if (array) return this.typesMayAlias(array.element, target, at, visited);
    const aggregate = aggregateType(container);
    if (!aggregate) return false;
    const definition = this.aggregate(aggregate, at);
    return definition.members.some((member) => this.typesMayAlias(member.type, target, at, visited));
  }

  private recordEffectiveType(node: RuntimeObject, type: CType, at: Location): void {
    const root = this.rootFor(node, at);
    if (!root.rawAllocation || node.byteView) return;
    const start = node.byteOffset;
    const end = start + node.size;
    const storedType = unqualifiedType(type);
    if (isCharacterType(storedType)) return;
    root.effectiveTypes.splice(0, root.effectiveTypes.length,
      ...root.effectiveTypes.filter((range) => range.start !== start || range.end !== end));
    root.effectiveTypes.push({ start, end, type: storedType, initialization: this.copyInitializationSnapshot(node, at) });
  }

  private bitFieldFor(node: RuntimeObject, at: Location): {
    readonly parent: RuntimeObject;
    readonly member: AggregateDefinition['members'][number];
  } | undefined {
    if (node.memberIndex === undefined || node.parentId === undefined) return undefined;
    const parent = this.records.get(node.parentId);
    const aggregate = parent ? aggregateType(parent.type) : undefined;
    if (!parent || !aggregate) return undefined;
    const member = this.aggregate(aggregate, at).members[node.memberIndex];
    return member?.bitField && member.bitField.width > 0 ? { parent, member } : undefined;
  }

  private bitFieldPromotionType(type: CType, bitField: NonNullable<AggregateDefinition['members'][number]['bitField']>): CType {
    const declared = unqualifiedType(type);
    const info = integerInfo(declared);
    if (!info) return declared;
    if (info.rank < 3 || info.rank === 3 && bitField.width < info.bits) return 'int';
    return declared;
  }

  private readBitField(
    node: RuntimeObject,
    bitField: NonNullable<AggregateDefinition['members'][number]['bitField']>,
    at: Location,
  ): ObjectScalarValue {
    const root = this.rootFor(node, at);
    const size = bitField.storageUnitSize;
    if (!node.initialized && !this.hasZeroInitializedAncestor(node)) {
      failure('UNINITIALIZED_READ', 'Reading an uninitialized bit-field is undefined behavior in C11.', at);
    }
    const bytes = Array.from({ length: size }, (_, index) =>
      root.representation.get(node.byteOffset + index) ?? (this.hasZeroInitializedAncestor(node) ? 0 : undefined));
    if (bytes.some((byte) => byte === undefined)) failure('UNINITIALIZED_READ', 'The bit-field unit contains indeterminate bits.', at);
    const raw = this.fromBytes(bytes as number[]);
    const value = (raw >> BigInt(bitField.bitOffset)) & ((1n << BigInt(bitField.width)) - 1n);
    return bitField.signed ? BigInt.asIntN(bitField.width, value) : value;
  }

  private writeBitField(
    node: RuntimeObject,
    bitField: NonNullable<AggregateDefinition['members'][number]['bitField']>,
    value: ObjectScalarValue,
    at: Location,
  ): bigint {
    if (typeof value !== 'bigint') failure('TYPE_ERROR', 'The bit-field value must be an integer.', at);
    const root = this.rootFor(node, at);
    const widthMask = (1n << BigInt(bitField.width)) - 1n;
    const shiftedMask = widthMask << BigInt(bitField.bitOffset);
    const oldBytes = Array.from({ length: bitField.storageUnitSize }, (_, index) =>
      root.representation.get(node.byteOffset + index) ?? 0);
    const oldValue = this.fromBytes(oldBytes);
    const nextValue = (oldValue & ~shiftedMask) | ((BigInt.asUintN(bitField.width, value) & widthMask) << BigInt(bitField.bitOffset));
    const bytes = this.toBytes(nextValue, bitField.storageUnitSize);
    const end = node.byteOffset + bitField.storageUnitSize;
    this.clearPointerProvenance(root, node.byteOffset, end);
    this.invalidatePointerObjectCaches(root, node.byteOffset, end);
    bytes.forEach((byte, index) => root.representation.set(node.byteOffset + index, byte));
    const assigned = bitField.signed ? BigInt.asIntN(bitField.width, value) : BigInt.asUintN(bitField.width, value);
    node.value = assigned;
    node.initialized = true;
    node.zeroInitialized = false;
    this.recordEffectiveType(node, node.type, at);
    return assigned;
  }

  private aggregate(type: CType, at: Location): AggregateDefinition {
    const aggregate = aggregateType(type);
    const definition = aggregate && this.aggregates.find((item) => item.id === aggregate.id);
    if (!definition?.complete) failure('INCOMPLETE_TYPE', `Aggregate type ${aggregate?.id ?? '?'} is incomplete.`, at);
    return definition;
  }

  private alignment(type: CType, at: Location): number {
    // Alignment is the stride divisor for valid typed pointer accesses.
    return alignOfType(type, this.aggregates, at);
  }

  private zeroValue(type: CType, at: Location): ObjectScalarValue {
    if (isPointer(type)) return null;
    if (type === 'long double') return binary80Zero();
    if (isScalar(type)) return type === 'float' || type === 'double' ? 0 : 0n;
    if (isFunction(type)) return { kind: 'function-pointer', functionIndex: null } satisfies FunctionPointerValue;
    failure('INVALID_ZERO_INITIALIZER', 'The type does not allow scalar zero initialization.', at);
  }

  private rootFor(node: RuntimeObject, at: Location): AllocationRoot {
    const root = this.roots.get(node.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The object lifetime has ended.', at);
    return root;
  }

  private writeRepresentation(node: RuntimeObject, value: ObjectScalarValue, at: Location): void {
    if (!isScalar(node.type)) return;
    const root = this.rootFor(node, at);
    const bytes = this.encodeScalar(node.type, value, at);
    const end = node.byteOffset + bytes.length;
    this.clearPointerProvenance(root, node.byteOffset, end);
    this.invalidatePointerObjectCaches(root, node.byteOffset, end, node.id);
    if (isPointer(node.type) && value !== null && typeof value === 'object' && value.kind === 'object-pointer') {
      root.pointerValues.set(node.byteOffset, { ...value });
    }
    bytes.forEach((byte, index) => root.representation.set(node.byteOffset + index, byte));
  }

  private clearRepresentation(node: RuntimeObject, at: Location): void {
    const root = this.rootFor(node, at);
    const end = node.byteOffset + node.size;
    for (const offset of root.representation.keys()) if (offset >= node.byteOffset && offset < end) root.representation.delete(offset);
    this.clearPointerProvenance(root, node.byteOffset, end);
    this.invalidatePointerObjectCaches(root, node.byteOffset, end);
  }

  private readScalar(node: RuntimeObject, at: Location): ObjectScalarValue {
    const root = this.rootFor(node, at);
    if (node.byteView) {
      const byte = this.readRepresentationByte(root, node.byteOffset, at);
      return node.type === 'unsigned char' ? BigInt(byte) : BigInt.asIntN(8, BigInt(byte));
    }
    const size = sizeOfType(node.type, this.aggregates, at);
    const fullyRepresented = Array.from({ length: size }, (_, index) => root.representation.has(node.byteOffset + index)).every(Boolean);
    const zeroInitialized = this.hasZeroInitializedAncestor(node);
    if (node.rawView && !node.initialized && !zeroInitialized && !fullyRepresented) {
      failure('UNINITIALIZED_READ', 'malloc storage does not yet contain an object of this type.', at);
    }
    if (!node.initialized && !zeroInitialized && !fullyRepresented) {
      failure('UNINITIALIZED_READ', 'Reading an uninitialized object is undefined behavior in C11.', at);
    }
    const bytes = Array.from({ length: size }, (_, index) =>
      root.representation.get(node.byteOffset + index) ?? (zeroInitialized ? 0 : undefined));
    if (bytes.some((byte) => byte === undefined)) failure('UNINITIALIZED_READ', 'The object representation contains indeterminate bytes.', at);
    if (isPointer(node.type)) {
      const pointerValue = root.pointerValues.get(node.byteOffset);
      if (pointerValue) return pointerValue;
    }
    if (node.initialized && isPointer(node.type) && node.value !== undefined) {
      const storedValue = this.encodeScalar(node.type, node.value, at);
      if (storedValue.every((byte, index) => byte === bytes[index])) return node.value;
    }
    return this.decodeScalar(node.type, bytes as number[], at);
  }

  /** Capture complete object-pointer representations for memcpy/memmove. */
  copyablePointerValues(pointer: ObjectPointerValue, count: number, at: Location): readonly {
    readonly relativeOffset: number;
    readonly value: ObjectPointerValue;
  }[] {
    const root = this.roots.get(pointer.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The pointer refers to an object whose lifetime has ended.', at);
    const end = pointer.byteOffset + count;
    if (!Number.isSafeInteger(count) || count < 0 || pointer.byteOffset < pointer.boundsStart || end > pointer.boundsEnd) {
      failure('POINTER_BOUNDS', 'Copy exceeds the pointed-to object.', at);
    }
    const pointerSize = 8;
    return Object.freeze([...root.pointerValues.entries()]
      .filter(([offset]) => offset >= pointer.byteOffset && offset + pointerSize <= end)
      .map(([offset, value]) => Object.freeze({ relativeOffset: offset - pointer.byteOffset, value: { ...value } })));
  }

  /** Restore provenance after those pointer bytes have been copied through character views. */
  restoreCopiedPointerValues(
    pointer: ObjectPointerValue,
    count: number,
    values: readonly { readonly relativeOffset: number; readonly value: ObjectPointerValue }[],
    at: Location,
  ): void {
    const root = this.roots.get(pointer.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The pointer refers to an object whose lifetime has ended.', at);
    const end = pointer.byteOffset + count;
    if (!Number.isSafeInteger(count) || count < 0 || pointer.byteOffset < pointer.boundsStart || end > pointer.boundsEnd) {
      failure('POINTER_BOUNDS', 'Copy exceeds the pointed-to object.', at);
    }
    this.clearPointerProvenance(root, pointer.byteOffset, end);
    for (const { relativeOffset, value } of values) {
      if (relativeOffset >= 0 && relativeOffset + 8 <= count) {
        root.pointerValues.set(pointer.byteOffset + relativeOffset, { ...value });
      }
    }
  }

  /** Capture effective-type shadow for the exact bytes copied by memcpy/memmove. */
  copyableEffectiveTypes(pointer: ObjectPointerValue, count: number, at: Location): readonly EffectiveTypeCopy[] {
    const root = this.roots.get(pointer.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The pointer refers to an object whose lifetime has ended.', at);
    const end = pointer.byteOffset + count;
    if (!Number.isSafeInteger(count) || count < 0 || pointer.byteOffset < pointer.boundsStart || end > pointer.boundsEnd) {
      failure('POINTER_BOUNDS', 'Copy exceeds the pointed-to object.', at);
    }
    if (root.rawAllocation) {
      return Object.freeze(root.effectiveTypes
        .filter((range) => range.start >= pointer.byteOffset && range.end <= end)
        .map((range) => Object.freeze({
          relativeOffset: range.start - pointer.byteOffset, size: range.end - range.start, type: range.type,
          ...(range.initialization === undefined ? {} : { initialization: range.initialization }),
        })));
    }
    const candidates = [...this.records.values()]
      .filter((node) => node.alive && node.allocationId === root.allocationId &&
        node.byteOffset === pointer.byteOffset && node.size === count)
      .sort((left, right) => Number(right.id === pointer.arrayId) - Number(left.id === pointer.arrayId));
    const source = candidates[0];
    return source
      ? Object.freeze([Object.freeze({
        relativeOffset: 0, size: count, type: unqualifiedType(source.type),
        initialization: this.copyInitializationSnapshot(source, at),
      })])
      : Object.freeze([]);
  }

  /** Replace destination shadow after byte-wise writes so copies retain source effective type. */
  restoreCopiedEffectiveTypes(
    pointer: ObjectPointerValue,
    count: number,
    types: readonly EffectiveTypeCopy[],
    at: Location,
  ): void {
    const root = this.roots.get(pointer.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The pointer refers to an object whose lifetime has ended.', at);
    const end = pointer.byteOffset + count;
    if (!Number.isSafeInteger(count) || count < 0 || pointer.byteOffset < pointer.boundsStart || end > pointer.boundsEnd) {
      failure('POINTER_BOUNDS', 'Copy exceeds the pointed-to object.', at);
    }
    if (count === 0) return;
    if (root.rawAllocation) {
      root.effectiveTypes.splice(0, root.effectiveTypes.length,
        ...root.effectiveTypes.filter((range) => range.end <= pointer.byteOffset || range.start >= end));
      for (const view of this.rawViews.get(root.allocationId)?.values() ?? []) {
        if (view.byteOffset < end && view.byteOffset + view.size > pointer.byteOffset) {
          this.resetTree(view, false);
          view.initializationShadow = undefined;
          view.initializationShadowApplied = false;
        }
      }
    }
    for (const item of types) {
      if (item.relativeOffset < 0 || item.size < 0 || item.relativeOffset + item.size > count) continue;
      const start = pointer.byteOffset + item.relativeOffset;
      const copiedType = unqualifiedType(item.type);
      if (root.rawAllocation) root.effectiveTypes.push({
        start,
        end: start + item.size,
        type: copiedType,
        ...(item.initialization === undefined ? {} : { initialization: item.initialization }),
      });
      else if (item.initialization !== undefined) {
        const target = [...this.records.values()].find((node) => node.alive && node.allocationId === root.allocationId &&
          node.byteOffset === start && node.size === item.size && sameType(node.type, copiedType));
        if (target) {
          this.resetTree(target, false);
          target.initializationShadow = undefined;
          target.initializationShadowApplied = false;
          this.applyInitializationSnapshot(target, item.initialization, at);
        }
      }
    }
    if (root.rawAllocation) this.applyInitializationShadows(root, at);
  }

  private clearPointerProvenance(root: AllocationRoot, start: number, end: number): void {
    for (const offset of root.pointerValues.keys()) {
      if (offset < end && offset + 8 > start) root.pointerValues.delete(offset);
    }
  }

  private invalidatePointerObjectCaches(root: AllocationRoot, start: number, end: number, preserveObjectId?: number): void {
    for (const node of root.pointerObjects) {
      if (node.id === preserveObjectId) continue;
      if (node.byteOffset < end && node.byteOffset + node.size > start) {
        node.initialized = false;
        node.value = undefined;
      }
    }
  }

  private readRepresentationByte(root: AllocationRoot, offset: number, at: Location): number {
    const stored = root.representation.get(offset);
    if (stored !== undefined) return stored;
    if (this.hasZeroInitializedAncestor(root)) return 0;
    const leaf = this.leafAt(root, offset, at);
    if (leaf && (leaf.initialized || this.hasZeroInitializedAncestor(leaf))) {
      if (isScalar(leaf.type) && leaf.value !== undefined) {
        const bytes = this.encodeScalar(leaf.type, this.readScalar(leaf, at), at);
        return bytes[offset - leaf.byteOffset] ?? 0;
      }
      return 0;
    }
    if (leaf) failure('UNINITIALIZED_READ', 'Reading a byte from an uninitialized object is undefined behavior in C11.', at);
    if (this.hasInitializedDescendant(root)) return 0; // LP64 profile choice for padding bytes.
    failure('UNINITIALIZED_READ', 'Reading a byte from an uninitialized object is undefined behavior in C11.', at);
  }

  private leafAt(parent: RuntimeObject, offset: number, at: Location): RuntimeObject | undefined {
    if (isScalar(parent.type)) return offset >= parent.byteOffset && offset < parent.byteOffset + parent.size ? parent : undefined;
    const array = arrayType(parent.type);
    const aggregate = aggregateType(parent.type);
    if (array) {
      const stride = sizeOfType(array.element, this.aggregates, at);
      const delta = offset - parent.byteOffset;
      if (delta < 0 || delta >= parent.size || array.length === null) return undefined;
      const index = Math.floor(delta / stride);
      const ref = this.child(parent, index, at);
      return this.leafAt(this.records.get(ref.objectId)!, offset, at);
    }
    if (aggregate) {
      const definition = this.aggregate(aggregate, at);
      const root = this.rootFor(parent, at);
      const candidates = definition.members.filter((member) => {
        const start = parent.byteOffset + member.offset;
        const memberSize = member.bitField
          ? member.bitField.storageUnitSize
          : member.flexibleArray
            ? Math.max(0, root.byteOffset + root.size - start)
            : sizeOfType(member.type, this.aggregates, at);
        return offset >= start && offset < start + memberSize;
      });
      if (definition.kind === 'union' && parent.activeMember !== undefined) {
        const active = candidates.find((member) => member.index === parent.activeMember);
        if (active) candidates.splice(0, candidates.length, active);
      }
      for (const member of candidates) {
        const ref = this.child(parent, member.index, at, member);
        const leaf = this.leafAt(this.records.get(ref.objectId)!, offset, at);
        if (leaf) return leaf;
      }
    }
    return undefined;
  }

  private hasZeroInitializedAncestor(node: RuntimeObject): boolean {
    let current: RuntimeObject | undefined = node;
    while (current) {
      if (current.zeroInitialized) return true;
      current = current.parentId === undefined ? undefined : this.records.get(current.parentId);
    }
    return false;
  }

  private hasInitializedDescendant(node: RuntimeObject): boolean {
    if (node.initialized || node.zeroInitialized) return true;
    for (const child of node.children.values()) if (this.hasInitializedDescendant(child)) return true;
    return false;
  }

  private encodeScalar(type: CType, value: ObjectScalarValue, at: Location): number[] {
    type = unqualifiedType(type);
    const size = sizeOfType(type, this.aggregates, at);
    if (type === 'long double') {
      if (typeof value !== 'object' || value === null || value.kind !== 'binary80') {
        failure('TYPE_ERROR', 'long double requires a binary80 value.', at);
      }
      const payload = binary80Encode80(value);
      return Array.from({ length: size }, (_, index) => payload[index] ?? 0);
    }
    if (isPointer(type)) {
      let address = 0n;
      if (value !== null) {
        if (typeof value !== 'object') failure('INVALID_POINTER_REPRESENTATION', 'The value is not a pointer representation.', at);
        if (value.kind === 'object-pointer') {
          const target = this.roots.get(value.allocationId);
          if (!target) failure('INVALID_POINTER_REPRESENTATION', 'The pointer does not identify a virtual object.', at);
          address = target.virtualBase + BigInt(value.byteOffset);
        } else if (value.kind === 'function-pointer') {
          if (value.functionIndex !== null) {
            address = (1n << 63n) | BigInt(value.functionIndex + 1);
            this.functionRepresentations.set(address, value);
          }
        } else failure('INVALID_POINTER_REPRESENTATION', 'The value is not a pointer.', at);
      }
      return this.toBytes(address, size);
    }
    if (typeof value === 'number') {
      const buffer = new ArrayBuffer(size);
      const view = new DataView(buffer);
      if (type === 'float') view.setFloat32(0, value, true);
      else if (type === 'double') view.setFloat64(0, value, true);
      else failure('TYPE_ERROR', `Type ${String(type)} requires an integer representation.`, at);
      return Array.from(new Uint8Array(buffer));
    }
    if (typeof value !== 'bigint' || !isInteger(type)) failure('TYPE_ERROR', `No scalar representation exists for ${String(type)}.`, at);
    return this.toBytes(BigInt.asUintN(size * 8, value), size);
  }

  private decodeScalar(type: CType, bytes: number[], at: Location): ObjectScalarValue {
    type = unqualifiedType(type);
    if (type === 'long double') return binary80Decode80(bytes.slice(0, 10));
    if (isPointer(type)) {
      const address = this.fromBytes(bytes);
      if (address === 0n) return null;
      if (isFunction(pointedToType(type) ?? 'void')) {
        const known = this.functionRepresentations.get(address);
        if (known) return known;
        if ((address & (1n << 63n)) !== 0n) return { kind: 'function-pointer', functionIndex: Number(address & ((1n << 63n) - 1n)) - 1 };
        failure('INVALID_POINTER_REPRESENTATION', 'The bytes do not represent a valid function pointer in the LP64 profile.', at);
      }
      for (const root of this.roots.values()) {
        const delta = address - root.virtualBase;
        if (delta >= 0n && delta <= BigInt(root.size)) {
          return { kind: 'object-pointer', allocationId: root.allocationId, arrayId: root.id,
            byteOffset: Number(delta), boundsStart: 0, boundsEnd: root.size };
        }
      }
      failure('INVALID_POINTER_REPRESENTATION', 'The bytes do not represent a valid object pointer in the LP64 profile.', at);
    }
    if (type === 'float' || type === 'double') {
      const view = new DataView(Uint8Array.from(bytes).buffer);
      return type === 'float' ? view.getFloat32(0, true) : view.getFloat64(0, true);
    }
    const info = integerInfo(type);
    if (!info || !isInteger(type)) failure('TYPE_ERROR', `No integer representation exists for ${String(type)}.`, at);
    const raw = this.fromBytes(bytes), bits = bytes.length * 8;
    if (type === '_Bool') return raw === 0n ? 0n : 1n;
    return info.unsigned ? BigInt.asUintN(bits, raw) : BigInt.asIntN(bits, raw);
  }

  private toBytes(value: bigint, size: number): number[] {
    const normalized = BigInt.asUintN(size * 8, value);
    return Array.from({ length: size }, (_, index) => Number((normalized >> BigInt(index * 8)) & 0xffn));
  }

  private fromBytes(bytes: readonly number[]): bigint {
    return bytes.reduce((value, byte, index) => value | BigInt(byte) << BigInt(index * 8), 0n);
  }

  private arrayIndex(pointer: ObjectPointerValue): number | undefined {
    const root = this.records.get(pointer.arrayId);
    const array = root ? arrayType(root.type) : undefined;
    if (!array) return undefined;
    const stride = scalarOrAggregateSize(array.element, this.aggregates);
    return stride && (pointer.byteOffset - pointer.boundsStart) % stride === 0 ? (pointer.byteOffset - pointer.boundsStart) / stride : undefined;
  }

  private typeKey(type: CType): string {
    type = unqualifiedType(type);
    if (typeof type === 'string') return type;
    const pointer = pointerType(type);
    if (pointer) return `p(${this.typeKey(pointer.base)})`;
    const array = arrayType(type);
    if (array) return `a${array.length ?? '?'}(${this.typeKey(array.element)})`;
    const aggregate = aggregateType(type);
    if (aggregate) return `g${aggregate.id}`;
    if (typeof type !== 'string' && type.kind === 'enum') return `e${type.id}`;
    const fn = functionType(type);
    return fn ? `f(${this.typeKey(fn.returnType)}:${fn.parameters.map((item) => this.typeKey(item)).join(',')})` : 'unknown';
  }

  private get rawViews(): Map<number, Map<string, RuntimeObject>> {
    if (!this.rawViewsValue) this.rawViewsValue = new Map();
    return this.rawViewsValue;
  }
  private rawViewsValue?: Map<number, Map<string, RuntimeObject>>;
}

function scalarOrAggregateSize(type: CType, aggregates: readonly AggregateDefinition[]): number {
  try { return sizeOfType(type, aggregates); } catch { return 0; }
}

function isCharacterType(type: CType): boolean {
  const unqualified = unqualifiedType(type);
  return unqualified === 'char' || unqualified === 'signed char' || unqualified === 'unsigned char';
}
