import { enforceLimit, failure } from './internal.ts';
import type {
  AggregateDefinition, AggregateValue, CType, CValue, FunctionPointerValue, Location, ObjectPointerValue,
  ObjectReference, ObjectScalarValue, ObjectSnapshot, StorageDuration,
} from './internal.ts';
import { alignOfType, arrayOf, compatibleType, isAggregate, isArithmetic, isArray, isFunction, isInteger, isPointer, isScalar, pointerTo, sameType, sizeOfType } from './type-system.ts';
import { VIRTUAL_HEAP_LAYOUT, VIRTUAL_MEMORY_LAYOUT } from './types.ts';
import type { DebugPointerStatus, EngineMetrics } from './types.ts';

const ALLOCATION_ALIGNMENT = BigInt(VIRTUAL_MEMORY_LAYOUT.alignmentBytes);

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
  /** Pointer-typed subobjects whose cached C values can be invalidated by byte writes. */
  readonly pointerObjects: Set<RuntimeObject>;
  readonly heapSlotCount?: bigint;
}

interface RuntimeObjectDescription {
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
    if (!root) failure('INACTIVE_OBJECT', 'La referencia no identifica una asignación activa.', at);
    return {
      objectId: root.id,
      allocationId: root.allocationId,
      duration: root.duration,
      addressVirtual: root.virtualBase,
      size: root.size,
    };
  }

  rootReference(allocationId: number): ObjectReference | undefined {
    const root = this.roots.get(allocationId);
    return root?.alive ? this.reference(root) : undefined;
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

  allocate(type: CType, duration: StorageDuration, at: Location): ObjectReference {
    const size = sizeOfType(type, this.aggregates, at);
    return this.allocateRoot(type, size, duration, at, false);
  }

  allocateRaw(bytes: number, at: Location): ObjectPointerValue | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) failure('INVALID_ALLOCATION_SIZE', 'malloc requiere un tamaño entero seguro no negativo.', at);
    // This profile chooses the permitted C11 behavior that malloc(0) returns null.
    if (bytes === 0) return null;
    const nextBytes = this.nextAllocationByteCount(bytes, at);
    const heapAddress = this.chooseHeapAddress(bytes, at);
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

  release(ref: ObjectReference, at: Location): void {
    const node = this.nodeFor(ref, at);
    if (node.id !== node.allocationId) failure('INVALID_OBJECT_RELEASE', 'Solo se puede terminar la duración de un objeto raíz automático.', at);
    if (node.duration !== 'automatic' && node.duration !== 'compound-literal') failure('INVALID_OBJECT_RELEASE', 'El objeto no tiene duración automática.', at);
    this.invalidateRoot(node.allocationId, at);
  }

  free(pointer: ObjectPointerValue | null, at: Location): void {
    if (pointer === null) return;
    const root = this.roots.get(pointer.allocationId);
    if (!root || !root.alive || root.duration !== 'heap' || !root.rawAllocation || pointer.byteOffset !== root.byteOffset || pointer.arrayId !== root.id) {
      failure('INVALID_FREE', 'free requiere null o el puntero base de un bloque vivo reservado con malloc.', at);
    }
    this.invalidateRoot(root.allocationId, at);
  }

  staticObject(key: object, type: CType, at: Location, duration: StorageDuration = 'static'): ObjectReference {
    const prior = this.staticObjects.get(key);
    if (prior) return prior;
    const ref = this.allocate(type, duration, at);
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
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) failure('INVALID_STRING_LITERAL', 'El literal de cadena contiene una unidad que no es un byte.', at);
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

  automaticObject(key: object, type: CType, scopeToken: object, at: Location): ObjectReference {
    let byScope = this.automaticObjects.get(key);
    if (!byScope) { byScope = new WeakMap(); this.automaticObjects.set(key, byScope); }
    const prior = byScope.get(scopeToken);
    if (prior) return prior;
    const ref = this.allocate(type, 'compound-literal', at);
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
    if (!isArray(parent.type)) failure('INVALID_SUBSCRIPT', 'El subíndice requiere un objeto array.', at);
    const numericIndex = typeof index === 'bigint' ? Number(index) : index;
    if (!Number.isSafeInteger(numericIndex) || numericIndex < 0 || parent.type.length === null || numericIndex >= parent.type.length) {
      failure('ARRAY_BOUNDS', 'El índice está fuera de los límites del array.', at);
    }
    return this.child(parent, numericIndex, at);
  }

  member(ref: ObjectReference, index: number, at: Location): ObjectReference {
    const parent = this.nodeFor(ref, at);
    if (!isAggregate(parent.type)) failure('INVALID_MEMBER_ACCESS', 'El acceso a miembro requiere un struct o union.', at);
    const definition = this.aggregate(parent.type, at);
    const member = definition.members[index];
    if (!member) failure('UNKNOWN_MEMBER', `No existe el miembro con índice ${index}.`, at);
    return this.child(parent, index, at, member);
  }

  dereference(pointer: CValue, at: Location): ObjectReference {
    if (!isPointer(pointer.type)) failure('INVALID_POINTER_ACCESS', 'La desreferencia requiere un puntero.', at);
    if (pointer.type.base === 'void' || isFunction(pointer.type.base)) failure('INVALID_POINTER_ACCESS', 'El puntero no designa un objeto completo.', at);
    if (pointer.value === null) failure('NULL_DEREFERENCE', 'No se puede desreferenciar un puntero nulo.', at);
    const address = pointer.value as ObjectPointerValue;
    if (!address || address.kind !== 'object-pointer') failure('INVALID_POINTER_ACCESS', 'El valor no es una dirección de objeto.', at);
    const root = this.roots.get(address.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'El puntero refiere a un objeto cuya duración terminó.', at);
    const size = sizeOfType(pointer.type.base, this.aggregates, at);
    const end = address.byteOffset + size;
    if (address.byteOffset < address.boundsStart || address.byteOffset >= address.boundsEnd || end > address.boundsEnd) {
      failure('POINTER_BOUNDS', 'El acceso cae fuera del objeto apuntado o usa un puntero one-past.', at);
    }
    const alignment = this.alignment(pointer.type.base, at);
    if ((address.byteOffset - root.byteOffset) % alignment !== 0) failure('MISALIGNED_POINTER', 'El puntero no cumple la alineación del tipo apuntado.', at);
    const target = this.locate(root, address.byteOffset, pointer.type.base, at);
    return this.reference(target, {
      arrayId: address.arrayId,
      boundsStart: address.boundsStart,
      boundsEnd: address.boundsEnd,
      arrayIndex: this.arrayIndex(address),
    });
  }

  addressOf(ref: ObjectReference, pointerType?: Extract<CType, { kind: 'pointer' }>): CValue {
    const node = this.nodeFor(ref, { file: 'main.c', line: 1, column: 1 });
    const targetType = pointerType ?? { kind: 'pointer', base: node.type };
    if (targetType.base !== node.type && !compatibleType(targetType.base, node.type)) {
      failure('TYPE_ERROR', 'El tipo del puntero no coincide con el objeto direccionado.', { file: 'main.c', line: 1, column: 1 });
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
    if (!isArray(node.type)) failure('INVALID_ARRAY_DECAY', 'La conversión array-a-puntero requiere un array.', { file: 'main.c', line: 1, column: 1 });
    return {
      type: { kind: 'pointer', base: node.type.element },
      value: {
        kind: 'object-pointer', allocationId: node.allocationId, arrayId: node.id,
        byteOffset: node.byteOffset, boundsStart: node.byteOffset, boundsEnd: node.byteOffset + node.size,
      },
    };
  }

  pointerAdd(pointer: CValue, count: bigint, at: Location): CValue {
    if (!isPointer(pointer.type) || pointer.type.base === 'void' || isFunction(pointer.type.base) || !pointer.value) {
      failure('INVALID_POINTER_ARITHMETIC', 'La aritmética requiere un puntero no nulo a tipo de objeto completo.', at);
    }
    if (typeof pointer.value !== 'object' || pointer.value.kind !== 'object-pointer') failure('INVALID_POINTER_ARITHMETIC', 'La aritmética requiere un puntero a objeto.', at);
    this.assertAlive(pointer, at);
    const address = pointer.value;
    const stride = sizeOfType(pointer.type.base, this.aggregates, at);
    const offset = BigInt(address.byteOffset) + count * BigInt(stride);
    if (offset < BigInt(address.boundsStart) || offset > BigInt(address.boundsEnd) || (offset - BigInt(address.boundsStart)) % BigInt(stride) !== 0n) {
      failure('POINTER_BOUNDS', 'La aritmética produjo una dirección fuera del array o más allá de one-past.', at);
    }
    const result = Number(offset);
    if (!Number.isSafeInteger(result)) failure('POINTER_BOUNDS', 'La dirección virtual excede el perfil representable.', at);
    return { type: pointer.type, value: { ...address, byteOffset: result } };
  }

  pointerDifference(left: CValue, right: CValue, at: Location): CValue {
    if (!isPointer(left.type) || !isPointer(right.type) || !sameType(left.type.base, right.type.base) || !left.value || !right.value ||
      typeof left.value !== 'object' || typeof right.value !== 'object' || left.value.kind !== 'object-pointer' || right.value.kind !== 'object-pointer') {
      failure('INVALID_POINTER_DIFFERENCE', 'La resta requiere punteros compatibles dentro del mismo array.', at);
    }
    this.assertAlive(left, at);
    this.assertAlive(right, at);
    const a = left.value, b = right.value;
    if (a.allocationId !== b.allocationId || a.arrayId !== b.arrayId) failure('INVALID_POINTER_DIFFERENCE', 'La resta de punteros de objetos distintos no está definida.', at);
    const stride = sizeOfType(left.type.base, this.aggregates, at);
    const difference = BigInt(a.byteOffset - b.byteOffset);
    if (difference % BigInt(stride) !== 0n) failure('INVALID_POINTER_DIFFERENCE', 'La diferencia no es un número entero de elementos.', at);
    const result = difference / BigInt(stride);
    if (result < -(1n << 63n) || result > (1n << 63n) - 1n) failure('POINTER_DIFFERENCE_RANGE', 'La diferencia de punteros excede ptrdiff_t del perfil.', at);
    return { type: 'long', value: result };
  }

  pointerRelationalCompare(left: CValue, right: CValue, operator: string, at: Location): boolean {
    if (!isPointer(left.type) || !isPointer(right.type) || !compatibleType(left.type.base, right.type.base) ||
        !left.value || !right.value || typeof left.value !== 'object' || typeof right.value !== 'object' ||
        left.value.kind !== 'object-pointer' || right.value.kind !== 'object-pointer') {
      failure('INVALID_POINTER_COMPARISON', 'La comparación relacional requiere punteros a objetos compatibles.', at);
    }
    const a = left.value, b = right.value;
    this.assertAlive(left, at);
    this.assertAlive(right, at);
    if (a.allocationId !== b.allocationId) {
      failure('INVALID_POINTER_COMPARISON', 'La comparación relacional de punteros de objetos distintos no está definida.', at);
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
          !sameType(leftObject.type, left.type.base) || !sameType(rightObject.type, right.type.base) ||
          parentId === undefined || parentId !== rightObject.parentId || !parent || !isAggregate(parent.type)) {
        failure('INVALID_POINTER_COMPARISON', 'La comparación relacional requiere elementos del mismo array o miembros del mismo agregado.', at);
      }
      const definition = this.aggregate(parent.type, at);
      if (leftObject.memberIndex === undefined || rightObject.memberIndex === undefined) {
        failure('INVALID_POINTER_COMPARISON', 'La comparación relacional requiere miembros del mismo agregado.', at);
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
    if (typeof pointer.value !== 'object') failure('INVALID_POINTER_ACCESS', 'El valor no representa un puntero.', at);
    if (pointer.value.kind === 'function-pointer') return;
    if (pointer.value.kind !== 'object-pointer') failure('INVALID_POINTER_ACCESS', 'El valor no representa un puntero a objeto.', at);
    const root = this.roots.get(pointer.value.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'El puntero refiere a un objeto cuya duración terminó.', at);
  }

  /** Format the actual LP64 virtual pointer representation for the library's %p conversion. */
  formatPointer(pointer: CValue, at: Location): string {
    if (!isPointer(pointer.type)) failure('INVALID_POINTER_FORMAT', 'El valor de %p no es un puntero.', at);
    if (pointer.value === null) return '0x0';
    if (typeof pointer.value !== 'object') failure('INVALID_POINTER_FORMAT', 'El valor de %p no es una representación de puntero.', at);
    if (pointer.value.kind === 'object-pointer') {
      this.assertAlive(pointer, at);
      const value = pointer.value;
      const root = this.roots.get(value.allocationId);
      const array = this.records.get(value.arrayId);
      if (!root || !array || array.allocationId !== value.allocationId || value.boundsStart < 0 ||
          value.boundsEnd > root.size || value.boundsStart > value.byteOffset || value.byteOffset > value.boundsEnd) {
        failure('INVALID_POINTER_REPRESENTATION', 'El puntero no conserva una procedencia válida para %p.', at);
      }
      const address = root.virtualBase + BigInt(value.byteOffset);
      this.formattedObjectPointers.set(address, value);
      return `0x${address.toString(16)}`;
    }
    if (pointer.value.kind === 'function-pointer') {
      if (pointer.value.functionIndex === null) return '0x0';
      if (!Number.isSafeInteger(pointer.value.functionIndex) || pointer.value.functionIndex < 0) {
        failure('INVALID_POINTER_FORMAT', 'El puntero a función no tiene una representación válida.', at);
      }
      return `0x${((1n << 63n) | BigInt(pointer.value.functionIndex + 1)).toString(16)}`;
    }
    failure('INVALID_POINTER_FORMAT', 'El valor de %p no es un puntero.', at);
  }

  /** Parse only null or an object-pointer representation previously emitted by formatPointer. */
  parsePointer(text: string, at: Location): CValue {
    const match = /^0[xX]([0-9a-fA-F]+)$/.exec(text);
    if (!match) failure('INVALID_POINTER_REPRESENTATION', 'La entrada de %p no coincide con una representación emitida por %p.', at);
    const address = BigInt(`0x${match[1]}`);
    if (address === 0n) return { type: pointerTo('void'), value: null };
    const value = this.formattedObjectPointers.get(address);
    if (!value) failure('INVALID_POINTER_REPRESENTATION', 'La entrada de %p no corresponde a un puntero de objeto conocido.', at);
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
    if (isArray(node.type)) failure('ARRAY_VALUE', 'Un array debe convertirse a puntero antes de evaluarse como expresión.', at);
    if (isAggregate(node.type)) {
      const aggregate: AggregateValue = { kind: 'aggregate-value', snapshot: this.snapshot(node, at) };
      return { type: node.type, value: aggregate };
    }
    return { type: node.type, value: this.readScalar(node, at) };
  }

  /** Inspect an arithmetic scalar without turning an indeterminate read into a VM diagnostic. */
  inspectScalar(ref: ObjectReference, at: Location): { readonly initialized: boolean; readonly value?: ObjectScalarValue } {
    const node = this.nodeFor(ref, at);
    if (!isScalar(node.type) || isPointer(node.type)) {
      failure('TYPE_ERROR', 'La inspección escalar requiere un objeto aritmético.', at);
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
    if (!isPointer(node.type)) failure('TYPE_ERROR', 'La inspección de puntero requiere un objeto puntero.', at);
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
    if (isFunction(node.type.base) &&
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
    if (!isArray(parent.type) || parent.type.length === null ||
        !Number.isSafeInteger(index) || index < 0 || index >= parent.type.length ||
        !isArithmetic(parent.type.element)) return undefined;

    const type = parent.type.element;
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
    if (!isArithmetic(member.type)) failure('TYPE_ERROR', 'La inspección requiere un miembro aritmético de struct.', at);
    const child = member.parent.children.get(memberIndex);
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
    if (!isPointer(member.type)) failure('TYPE_ERROR', 'La inspección requiere un miembro puntero de struct.', at);
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
    if (isFunction(member.type.base) &&
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
    if (!root?.alive || node.id !== root.id || root.duration !== 'string-literal' ||
        !isArray(root.type) || root.type.element !== 'char' || root.type.length === null ||
        root.type.length !== root.size) return undefined;

    const bytes: number[] = [];
    for (let offset = 0; offset < root.size; offset++) {
      const byte = root.representation.get(root.byteOffset + offset);
      if (byte === undefined) return undefined;
      bytes.push(byte);
    }
    if (bytes.at(-1) !== 0) return undefined;
    return Object.freeze(bytes);
  }

  write(ref: ObjectReference, value: CValue, at: Location): void {
    const node = this.nodeFor(ref, at);
    this.ensureWritable(node, at);
    if (node.byteView) {
      if (!compatibleType(node.type, value.type)) failure('TYPE_ERROR', 'El valor no coincide con el tipo char de la vista de byte.', at);
      if (!isCharacterType(node.type) || typeof value.value !== 'bigint') failure('TYPE_ERROR', 'La vista de byte requiere un valor entero char.', at);
      const root = this.rootFor(node, at);
      const byte = Number(BigInt.asUintN(8, value.value));
      this.clearPointerProvenance(root, node.byteOffset, node.byteOffset + 1);
      this.invalidatePointerObjectCaches(root, node.byteOffset, node.byteOffset + 1);
      root.representation.set(node.byteOffset, byte);
      node.value = BigInt.asIntN(8, BigInt(byte));
      node.initialized = true;
      return;
    }
    this.activateContainingUnions(node, at);
    if (isArray(node.type)) failure('INVALID_LVALUE', 'Un array no se puede asignar como objeto completo.', at);
    if (isAggregate(node.type)) {
      if (!compatibleType(node.type, value.type) || typeof value.value !== 'object' || value.value === null || value.value.kind !== 'aggregate-value') {
        failure('TYPE_ERROR', 'La asignación de agregado necesita un valor del mismo tipo.', at);
      }
      this.restore(node, value.value.snapshot, at);
      return;
    }
    if (!compatibleType(node.type, value.type)) failure('TYPE_ERROR', 'El valor no es compatible con el tipo del objeto.', at);
    if (typeof value.value === 'object' && value.value !== null && value.value.kind === 'aggregate-value') {
      failure('TYPE_ERROR', 'Un valor agregado no puede almacenarse en un objeto escalar.', at);
    }
    node.value = value.value as ObjectScalarValue;
    node.initialized = true;
    this.writeRepresentation(node, node.value, at);
  }

  zeroInitialize(ref: ObjectReference, at: Location): void {
    const node = this.nodeFor(ref, at);
    this.ensureWritable(node, at);
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
  ): ObjectReference {
    const nextBytes = reservedNextBytes ?? this.nextAllocationByteCount(size, at);
    const reservation = duration === 'heap'
      ? heapReservation ?? failure('ENGINE_INTERNAL_ERROR', 'Falta la dirección seleccionada para una asignación heap.', at)
      : this.chooseSessionAddress(size, duration) ?? this.failRegionExhaustion(size, duration, at);
    const virtualBase = reservation.virtualBase;
    const region = this.regionForDuration(duration);
    if (virtualBase < region.start || reservation.endExclusive > region.endExclusive ||
        virtualBase + BigInt(size) + BigInt(VIRTUAL_MEMORY_LAYOUT.guardBytes) > reservation.endExclusive ||
        virtualBase % ALLOCATION_ALIGNMENT !== 0n) {
      failure('ENGINE_INTERNAL_ERROR', 'La reserva virtual queda fuera de su región o no respeta alineación y guard.', at);
    }
    if (duration === 'heap') {
      if (reservation.heapSlotCount === undefined) {
        failure('ENGINE_INTERNAL_ERROR', 'Falta el tamaño reservado para una asignación heap.', at);
      }
      const firstHeapSlot = (virtualBase - VIRTUAL_HEAP_LAYOUT.start) / ALLOCATION_ALIGNMENT;
      const endHeapSlot = firstHeapSlot + reservation.heapSlotCount;
      for (const [occupiedStart, occupiedEnd] of this.heapExtents) {
        if (firstHeapSlot < occupiedEnd && occupiedStart < endHeapSlot) {
          failure('ENGINE_INTERNAL_ERROR', 'El allocator seleccionó un intervalo heap ocupado.', at);
        }
      }
    } else {
      const extents = this.extentsForDuration(duration);
      for (const [occupiedStart, occupiedEnd] of extents) {
        if (virtualBase < occupiedEnd && occupiedStart < reservation.endExclusive) {
          failure('ENGINE_INTERNAL_ERROR', 'El allocator seleccionó un intervalo de objetos ocupado.', at);
        }
      }
    }
    const id = this.nextObjectId++;
    const root: AllocationRoot = {
      id, allocationId: id, type, byteOffset: 0, size, duration, rawAllocation: raw,
      virtualBase,
      representation: new Map(), pointerValues: new Map(), pointerObjects: new Set(),
      ...(duration === 'heap' ? { heapSlotCount: reservation.heapSlotCount! } : {}),
      initialized: false, zeroInitialized: false, alive: true, children: new Map(),
    };
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
  private chooseSessionAddress(size: number, duration: Exclude<StorageDuration, 'heap'>): AddressReservation | undefined {
    const region = this.regionForDuration(duration);
    const slotCount = this.reservationSlotCount(size);
    const reservedBytes = slotCount * ALLOCATION_ALIGNMENT;
    const occupied = [...this.extentsForDuration(duration).entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    let candidate = region.start;
    for (const [start, end] of occupied) {
      if (candidate + reservedBytes <= start) return { virtualBase: candidate, endExclusive: candidate + reservedBytes };
      if (end > candidate) candidate = end;
    }
    if (candidate + reservedBytes <= region.endExclusive) {
      return { virtualBase: candidate, endExclusive: candidate + reservedBytes };
    }
    return undefined;
  }

  private failRegionExhaustion(size: number, duration: Exclude<StorageDuration, 'heap'>, at: Location): never {
    const regionName = duration === 'automatic' || duration === 'compound-literal' ? 'Stack' : 'Static';
    const code = regionName === 'Stack' ? 'STACK_ADDRESS_SPACE_EXHAUSTED' : 'STATIC_ADDRESS_SPACE_EXHAUSTED';
    failure(code, `La región virtual ${regionName} no tiene espacio para reservar ${size} bytes C y su guard.`, at);
  }

  /** Choose a random aligned start with bounded probes, then scan live extents once as fallback. */
  private chooseHeapAddress(size: number, at: Location): AddressReservation | undefined {
    const heapRange = VIRTUAL_MEMORY_LAYOUT.heapAddressRange;
    const totalSlots = (heapRange.endExclusive - heapRange.start) / ALLOCATION_ALIGNMENT;
    const slotCount = this.reservationSlotCount(size);
    if (slotCount > totalSlots) return undefined;
    const latestStart = totalSlots - slotCount;
    const randomStart = (): bigint => {
      const random = this.heapAddressRandom();
      if (!Number.isFinite(random) || random < 0 || random >= 1) {
        failure('ENGINE_INTERNAL_ERROR', 'El generador de direcciones heap produjo un valor inválido.', at);
      }
      // Slot counts in the configured heap region stay exactly representable as Number.
      return BigInt(Math.floor(random * Number(latestStart + 1n)));
    };
    const fits = (first: bigint): boolean => {
      const end = first + slotCount;
      for (const [occupiedStart, occupiedEnd] of this.heapExtents) {
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
    const occupied = [...this.heapExtents.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    let candidate = 0n;
    for (const [start, end] of occupied) {
      if (start - candidate >= slotCount) {
        const virtualBase = heapRange.start + candidate * ALLOCATION_ALIGNMENT;
        return { virtualBase, endExclusive: heapRange.start + (candidate + slotCount) * ALLOCATION_ALIGNMENT, heapSlotCount: slotCount };
      }
      if (end > candidate) candidate = end;
    }
    if (totalSlots - candidate >= slotCount) {
      const virtualBase = heapRange.start + candidate * ALLOCATION_ALIGNMENT;
      return { virtualBase, endExclusive: heapRange.start + (candidate + slotCount) * ALLOCATION_ALIGNMENT, heapSlotCount: slotCount };
    }
    return undefined;
  }

  private invalidateRoot(id: number, at: Location): void {
    const root = this.roots.get(id);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'La duración del objeto ya terminó.', at);
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
    if (!node || node.allocationId !== ref.allocationId) failure('INACTIVE_OBJECT', 'La referencia no identifica un objeto activo.', at);
    const root = this.roots.get(node.allocationId);
    if (!node.alive || !root?.alive) failure('INACTIVE_OBJECT', 'La duración del objeto terminó.', at);
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
    if (!isAggregate(parent.type)) failure('INVALID_MEMBER_ACCESS', 'La inspección de miembro requiere un struct.', at);
    const definition = this.aggregate(parent.type, at);
    if (definition.kind !== 'struct') failure('TYPE_ERROR', 'La inspección de miembros visibles solo admite structs.', at);
    const member = definition.members[memberIndex];
    if (!member) failure('UNKNOWN_MEMBER', `No existe el miembro con índice ${memberIndex}.`, at);
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
    if (isArray(parent.type)) {
      if (parent.type.length === null || index < 0 || index >= parent.type.length) failure('ARRAY_BOUNDS', 'El índice está fuera de los límites del array.', at);
      type = parent.type.element;
      byteOffset = parent.byteOffset + index * sizeOfType(type, this.aggregates, at);
    } else if (isAggregate(parent.type)) {
      const definition = this.aggregate(parent.type, at);
      const selected = member ?? definition.members[index];
      if (!selected) failure('UNKNOWN_MEMBER', `No existe el miembro con índice ${index}.`, at);
      type = selected.type;
      byteOffset = parent.byteOffset + selected.offset;
      memberIndex = selected.index;
      index = selected.index;
    } else failure('INVALID_SUBOBJECT', 'El objeto no contiene subobjetos indexables.', at);

    let node = parent.children.get(index);
    if (node && node.type !== type && !sameType(node.type, type)) failure('ENGINE_INTERNAL_ERROR', 'El índice reutilizó un subobjeto con tipo incompatible.', at);
    if (!node) {
      const id = this.nextObjectId++;
      const inheritedZero = parent.zeroInitialized;
      node = {
        id, allocationId: parent.allocationId, type, byteOffset,
        size: sizeOfType(type, this.aggregates, at), duration: parent.duration,
        parentId: parent.id, childIndex: index, memberIndex, rawAllocation: false,
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
    }
    if (memberIndex !== undefined && isAggregate(parent.type) && this.aggregate(parent.type, at).kind === 'union' && parent.activeMember === undefined) {
      // A union without an initializer has no active member; creating its lvalue does not select one.
    }
    const parentArray = isArray(parent.type);
    return this.reference(node, parentArray ? {
      arrayId: parent.id,
      arrayIndex: index,
      arrayLength: parent.type.length!,
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
      if (byteOffset < root.byteOffset || byteOffset + size > root.byteOffset + root.size) failure('POINTER_BOUNDS', 'El acceso excede el bloque reservado.', at);
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
      return view;
    }
    const pending: RuntimeObject[] = [root];
    while (pending.length) {
      const current = pending.pop()!;
      if (current.byteOffset === byteOffset && sameType(current.type, type)) return current;
      if (isArray(current.type)) {
        const stride = sizeOfType(current.type.element, this.aggregates, at);
        const delta = byteOffset - current.byteOffset;
        if (delta < 0 || delta >= current.size || current.type.length === null) continue;
        // A nested element may start at an offset inside this array element
        // (for example matrix[0][1]); descend through the containing row.
        const index = Math.floor(delta / stride);
        const child = this.child(current, index, at);
        pending.push(this.records.get(child.objectId)!);
      } else if (isAggregate(current.type)) {
        const definition = this.aggregate(current.type, at);
        const candidates = definition.members.filter((member) => {
          const start = current.byteOffset + member.offset;
          const end = start + sizeOfType(member.type, this.aggregates, at);
          return byteOffset >= start && byteOffset < end;
        });
        candidates.sort((a, b) => Number(a.index !== current.activeMember) - Number(b.index !== current.activeMember));
        for (let index = candidates.length - 1; index >= 0; index--) {
          const child = this.child(current, candidates[index].index, at, candidates[index]);
          pending.push(this.records.get(child.objectId)!);
        }
      }
    }
    failure('INVALID_POINTER_ACCESS', 'La dirección no corresponde a un objeto del tipo apuntado.', at);
  }

  private readSnapshot(node: RuntimeObject, at: Location): ObjectSnapshot {
    const snapshot: {
      initialized: boolean; value?: ObjectScalarValue; zeroInitialized?: boolean;
      children?: Record<number, ObjectSnapshot>; activeMember?: number;
    } = { initialized: node.initialized };
    if (node.initialized && isScalar(node.type)) snapshot.value = this.readScalar(node, at);
    if (node.zeroInitialized) snapshot.zeroInitialized = true;
    if (node.activeMember !== undefined) snapshot.activeMember = node.activeMember;
    if (node.children.size) {
      const children: Record<number, ObjectSnapshot> = {};
      const activeUnion = isAggregate(node.type) && this.aggregate(node.type, at).kind === 'union' ? node.activeMember : undefined;
      for (const [index, child] of node.children) {
        if (activeUnion !== undefined && index !== activeUnion) continue;
        children[index] = this.readSnapshot(child, at);
      }
      snapshot.children = children;
    }
    return snapshot;
  }

  private snapshot(node: RuntimeObject, at: Location): ObjectSnapshot { return this.readSnapshot(node, at); }

  private restore(node: RuntimeObject, snapshot: ObjectSnapshot, at: Location): void {
    this.clearRepresentation(node, at);
    for (const child of node.children.values()) this.resetTree(child, !!snapshot.zeroInitialized);
    node.initialized = snapshot.initialized;
    node.value = snapshot.value;
    node.zeroInitialized = !!snapshot.zeroInitialized;
    node.activeMember = snapshot.activeMember;
    for (const [indexText, childSnapshot] of Object.entries(snapshot.children ?? {})) {
      const index = Number(indexText);
      const childRef = this.child(node, index, at);
      const child = this.nodeFor(childRef, at);
      this.restore(child, childSnapshot, at);
    }
    if (isScalar(node.type) && node.initialized && node.value !== undefined) this.writeRepresentation(node, node.value, at);
  }

  private activateContainingUnions(node: RuntimeObject, at: Location): void {
    let current = node;
    while (current.parentId !== undefined) {
      const parent = this.records.get(current.parentId);
      if (!parent) break;
      if (isAggregate(parent.type) && this.aggregate(parent.type, at).kind === 'union' && current.memberIndex !== undefined) {
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
    if (zeroInitialized && isAggregate(node.type)) {
      const aggregateType = node.type as Extract<CType, { kind: 'aggregate' }>;
      const definition = this.aggregates.find((item) => item.id === aggregateType.id);
      if (definition?.kind === 'union') node.activeMember = 0;
    }
    for (const child of node.children.values()) this.resetTree(child, zeroInitialized);
  }

  private ensureWritable(node: RuntimeObject, at: Location): void {
    if (node.duration === 'string-literal') failure('STRING_LITERAL_MODIFICATION', 'Modificar un literal de cadena tiene comportamiento indefinido en C11.', at);
  }

  private aggregate(type: Extract<CType, { kind: 'aggregate' }>, at: Location): AggregateDefinition {
    const definition = this.aggregates.find((item) => item.id === type.id);
    if (!definition?.complete) failure('INCOMPLETE_TYPE', `El tipo agregado ${type.id} está incompleto.`, at);
    return definition;
  }

  private alignment(type: CType, at: Location): number {
    // Alignment is the stride divisor for valid typed pointer accesses.
    return alignOfType(type, this.aggregates, at);
  }

  private zeroValue(type: CType, at: Location): ObjectScalarValue {
    if (isPointer(type)) return null;
    if (isScalar(type)) return type === 'float' || type === 'double' ? 0 : 0n;
    if (isFunction(type)) return { kind: 'function-pointer', functionIndex: null } satisfies FunctionPointerValue;
    failure('INVALID_ZERO_INITIALIZER', 'El tipo no admite inicialización cero escalar.', at);
  }

  private rootFor(node: RuntimeObject, at: Location): AllocationRoot {
    const root = this.roots.get(node.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'La duración del objeto terminó.', at);
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
      failure('UNINITIALIZED_READ', 'El almacenamiento de malloc aún no contiene un objeto de este tipo.', at);
    }
    if (!node.initialized && !zeroInitialized && !fullyRepresented) {
      failure('UNINITIALIZED_READ', 'Lectura de un objeto sin inicializar: comportamiento indefinido en C11.', at);
    }
    const bytes = Array.from({ length: size }, (_, index) =>
      root.representation.get(node.byteOffset + index) ?? (zeroInitialized ? 0 : undefined));
    if (bytes.some((byte) => byte === undefined)) failure('UNINITIALIZED_READ', 'La representación del objeto contiene bytes indeterminados.', at);
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
    if (!root?.alive) failure('INACTIVE_OBJECT', 'El puntero refiere a un objeto cuya duración terminó.', at);
    const end = pointer.byteOffset + count;
    if (!Number.isSafeInteger(count) || count < 0 || pointer.byteOffset < pointer.boundsStart || end > pointer.boundsEnd) {
      failure('POINTER_BOUNDS', 'La copia excede el objeto apuntado.', at);
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
    if (!root?.alive) failure('INACTIVE_OBJECT', 'El puntero refiere a un objeto cuya duración terminó.', at);
    const end = pointer.byteOffset + count;
    if (!Number.isSafeInteger(count) || count < 0 || pointer.byteOffset < pointer.boundsStart || end > pointer.boundsEnd) {
      failure('POINTER_BOUNDS', 'La copia excede el objeto apuntado.', at);
    }
    this.clearPointerProvenance(root, pointer.byteOffset, end);
    for (const { relativeOffset, value } of values) {
      if (relativeOffset >= 0 && relativeOffset + 8 <= count) {
        root.pointerValues.set(pointer.byteOffset + relativeOffset, { ...value });
      }
    }
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
    if (leaf) failure('UNINITIALIZED_READ', 'Lectura de un byte de un objeto sin inicializar: comportamiento indefinido en C11.', at);
    if (this.hasInitializedDescendant(root)) return 0; // LP64 profile choice for padding bytes.
    failure('UNINITIALIZED_READ', 'Lectura de un byte de un objeto sin inicializar: comportamiento indefinido en C11.', at);
  }

  private leafAt(parent: RuntimeObject, offset: number, at: Location): RuntimeObject | undefined {
    if (isScalar(parent.type)) return offset >= parent.byteOffset && offset < parent.byteOffset + parent.size ? parent : undefined;
    if (isArray(parent.type)) {
      const stride = sizeOfType(parent.type.element, this.aggregates, at);
      const delta = offset - parent.byteOffset;
      if (delta < 0 || delta >= parent.size || parent.type.length === null) return undefined;
      const index = Math.floor(delta / stride);
      const ref = this.child(parent, index, at);
      return this.leafAt(this.records.get(ref.objectId)!, offset, at);
    }
    if (isAggregate(parent.type)) {
      const definition = this.aggregate(parent.type, at);
      const candidates = definition.members.filter((member) => {
        const start = parent.byteOffset + member.offset;
        return offset >= start && offset < start + sizeOfType(member.type, this.aggregates, at);
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
    const size = sizeOfType(type, this.aggregates, at);
    if (isPointer(type)) {
      let address = 0n;
      if (value !== null) {
        if (typeof value !== 'object') failure('INVALID_POINTER_REPRESENTATION', 'El valor no es una representación de puntero.', at);
        if (value.kind === 'object-pointer') {
          const target = this.roots.get(value.allocationId);
          if (!target) failure('INVALID_POINTER_REPRESENTATION', 'El puntero no identifica un objeto virtual.', at);
          address = target.virtualBase + BigInt(value.byteOffset);
        } else if (value.kind === 'function-pointer') {
          if (value.functionIndex !== null) {
            address = (1n << 63n) | BigInt(value.functionIndex + 1);
            this.functionRepresentations.set(address, value);
          }
        } else failure('INVALID_POINTER_REPRESENTATION', 'El valor no es un puntero.', at);
      }
      return this.toBytes(address, size);
    }
    if (typeof value === 'number') {
      const buffer = new ArrayBuffer(size);
      const view = new DataView(buffer);
      if (type === 'float') view.setFloat32(0, value, true);
      else if (type === 'double') view.setFloat64(0, value, true);
      else failure('TYPE_ERROR', `El tipo ${String(type)} requiere una representación entera.`, at);
      return Array.from(new Uint8Array(buffer));
    }
    if (typeof value !== 'bigint' || !isInteger(type)) failure('TYPE_ERROR', `No existe una representación escalar para ${String(type)}.`, at);
    return this.toBytes(BigInt.asUintN(size * 8, value), size);
  }

  private decodeScalar(type: CType, bytes: number[], at: Location): ObjectScalarValue {
    if (isPointer(type)) {
      const address = this.fromBytes(bytes);
      if (address === 0n) return null;
      if (isFunction(type.base)) {
        const known = this.functionRepresentations.get(address);
        if (known) return known;
        if ((address & (1n << 63n)) !== 0n) return { kind: 'function-pointer', functionIndex: Number(address & ((1n << 63n) - 1n)) - 1 };
        failure('INVALID_POINTER_REPRESENTATION', 'Los bytes no representan un puntero a función válido en el perfil LP64.', at);
      }
      for (const root of this.roots.values()) {
        const delta = address - root.virtualBase;
        if (delta >= 0n && delta <= BigInt(root.size)) {
          return { kind: 'object-pointer', allocationId: root.allocationId, arrayId: root.id,
            byteOffset: Number(delta), boundsStart: 0, boundsEnd: root.size };
        }
      }
      failure('INVALID_POINTER_REPRESENTATION', 'Los bytes no representan un puntero a objeto válido en el perfil LP64.', at);
    }
    if (type === 'float' || type === 'double') {
      const view = new DataView(Uint8Array.from(bytes).buffer);
      return type === 'float' ? view.getFloat32(0, true) : view.getFloat64(0, true);
    }
    if (typeof type !== 'string' || !isInteger(type)) failure('TYPE_ERROR', `No existe una representación entera para ${String(type)}.`, at);
    const raw = this.fromBytes(bytes), bits = bytes.length * 8;
    if (type === '_Bool') return raw === 0n ? 0n : 1n;
    const unsigned = type.startsWith('unsigned ');
    return unsigned ? BigInt.asUintN(bits, raw) : BigInt.asIntN(bits, raw);
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
    if (!root || !isArray(root.type)) return undefined;
    const stride = scalarOrAggregateSize(root.type.element, this.aggregates);
    return stride && (pointer.byteOffset - pointer.boundsStart) % stride === 0 ? (pointer.byteOffset - pointer.boundsStart) / stride : undefined;
  }

  private typeKey(type: CType): string {
    if (typeof type === 'string') return type;
    if (type.kind === 'pointer') return `p(${this.typeKey(type.base)})`;
    if (type.kind === 'array') return `a${type.length ?? '?'}(${this.typeKey(type.element)})`;
    if (type.kind === 'aggregate') return `g${type.id}`;
    return `f(${this.typeKey(type.returnType)}:${type.parameters.map((item) => this.typeKey(item)).join(',')})`;
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
  return type === 'char' || type === 'signed char' || type === 'unsigned char';
}
