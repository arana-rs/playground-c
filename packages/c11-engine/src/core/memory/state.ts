import type { AggregateDefinition, CType, CValue, FunctionPointerValue, Location, ObjectPointerValue, ObjectReference, ObjectScalarValue, ObjectSnapshot, StorageDuration } from '../internal.ts';
import { sizeOfType, unqualifiedType } from '../type-system.ts';
import { VIRTUAL_MEMORY_LAYOUT } from '../types.ts';
import type { DebugPointerStatus, EngineMetrics } from '../types.ts';

export const ALLOCATION_ALIGNMENT = BigInt(VIRTUAL_MEMORY_LAYOUT.alignmentBytes);

export const CORRESPONDING_UNSIGNED: Readonly<Record<string, string>> = Object.freeze({
  'signed char': 'unsigned char',
  short: 'unsigned short',
  int: 'unsigned int',
  long: 'unsigned long',
  'long long': 'unsigned long long',
});

export const CORRESPONDING_SIGNED: Readonly<Record<string, string>> = Object.freeze({
  'unsigned char': 'signed char',
  'unsigned short': 'short',
  'unsigned int': 'int',
  'unsigned long': 'long',
  'unsigned long long': 'long long',
});

export interface AddressReservation {
  readonly virtualBase: bigint;
  /** End of the aligned extent, including its guard bytes. */
  readonly endExclusive: bigint;
  readonly heapSlotCount?: bigint;
}

export interface RuntimeObject {
  readonly id: number;
  readonly allocationId: number;
  type: CType;
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

export interface AllocationRoot extends RuntimeObject {
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

export interface EffectiveTypeRange {
  readonly start: number;
  readonly end: number;
  readonly type: CType;
  readonly initialization?: ObjectSnapshot;
}

export interface ConstRange {
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

export interface RuntimeObjectDescription {
  readonly objectId: number;
  readonly allocationId: number;
  readonly duration: StorageDuration;
  readonly addressVirtual: bigint;
  readonly size: number;
}

export interface RuntimeObjectViewDescription {
  readonly objectId: number;
  readonly allocationId: number;
  readonly duration: StorageDuration;
  readonly addressVirtual: bigint;
  readonly size: number;
  /** Bit-fields touch only their declared bits within a shared storage unit. */
  readonly bitMask?: bigint;
}

export interface PointerInspectionResult {
  readonly initialized: boolean;
  readonly status: DebugPointerStatus;
  readonly address?: bigint;
  readonly target?: { readonly allocationId: number; readonly byteOffset: number };
}

export function scalarOrAggregateSize(type: CType, aggregates: readonly AggregateDefinition[]): number {
  try { return sizeOfType(type, aggregates); } catch { return 0; }
}

export function isCharacterType(type: CType): boolean {
  const unqualified = unqualifiedType(type);
  return unqualified === 'char' || unqualified === 'signed char' || unqualified === 'unsigned char';
}

export abstract class MemoryBase {
  protected readonly records = new Map<number, RuntimeObject>();
  protected readonly roots = new Map<number, AllocationRoot>();
  protected readonly staticObjects = new WeakMap<object, ObjectReference>();
  protected readonly automaticObjects = new WeakMap<object, WeakMap<object, ObjectReference>>();
  protected readonly scopeObjects = new WeakMap<object, ObjectReference[]>();
  protected nextObjectId = 1;
  protected liveBytes = 0;
  protected readonly functionRepresentations = new Map<bigint, FunctionPointerValue>();
  protected readonly formattedObjectPointers = new Map<bigint, ObjectPointerValue>();

  /** Provenance shadow for pointer -> uintptr_t -> pointer round trips. */
  protected readonly integerPointerValues = new Map<bigint, ObjectPointerValue | FunctionPointerValue>();

  /** Occupied extents are indexed once per live allocation, not once per 16-byte slot. */
  protected readonly heapExtents = new Map<bigint, bigint>();

  /** Static objects persist until the session ends. */
  protected readonly staticExtents = new Map<bigint, bigint>();

  /** Automatic objects release their extents when their scope or frame ends. */
  protected readonly stackExtents = new Map<bigint, bigint>();

  /** Retain old bases only for debug sessions so dangling pointer values keep their exact address. */
  protected readonly pointerAllocationAddresses = new Map<number, bigint>();
  protected rawViewsValue?: Map<number, Map<string, RuntimeObject>>;

  get allocatedBytes(): number { return this.liveBytes; }

  constructor(
    protected readonly aggregates: readonly AggregateDefinition[],
    protected readonly maxMemoryBytes: number | null,
    protected readonly metrics: EngineMetrics,
    protected readonly heapAddressRandom: () => number = Math.random,
    protected readonly retainPointerAllocationAddresses = false,
  ) {}

  abstract retypePointer(ref: ObjectReference, type: CType, at: Location): ObjectReference;
  abstract describeObject(ref: ObjectReference, at: Location): RuntimeObjectDescription;
  abstract describeObjectView(ref: ObjectReference, at: Location): RuntimeObjectViewDescription;
  abstract rootReference(allocationId: number): ObjectReference | undefined;
  abstract integerObjectViewsInRange(allocationId: number, byteOffset: number, byteCount: number): readonly ObjectReference[];
  abstract heapAggregateReferences(): readonly ObjectReference[];
  abstract flexibleArrayExtent(ref: ObjectReference, memberIndex: number, at: Location): { readonly elementSize: number; readonly capacityBytes: number; readonly length: number; } | undefined;
  abstract inspectFlexibleArrayElement(ref: ObjectReference, memberIndex: number, index: number, at: Location): { readonly initialized: boolean; readonly value?: ObjectScalarValue } | undefined;
  abstract isAlive(ref: ObjectReference): boolean;
  abstract findStaticObject(key: object): ObjectReference | undefined;
  abstract findAutomaticObject(key: object, scopeToken: object): ObjectReference | undefined;
  abstract scopeObjectReferences(scopeToken: object): readonly ObjectReference[];
  abstract canFree(pointer: ObjectPointerValue | null): boolean;
  abstract allocate(type: CType, duration: StorageDuration, at: Location, options?: MemoryAllocationOptions): ObjectReference;
  abstract allocateRaw(bytes: number, at: Location): ObjectPointerValue | null;
  abstract allocateRawAligned(bytes: number, alignment: number, at: Location): ObjectPointerValue | null;
  abstract reallocateRaw(pointer: ObjectPointerValue | null, bytes: number, at: Location): ObjectPointerValue | null;
  abstract release(ref: ObjectReference, at: Location): void;
  abstract free(pointer: ObjectPointerValue | null, at: Location): void;
  abstract staticObject(key: object, type: CType, at: Location, duration?: StorageDuration, options?: MemoryAllocationOptions): ObjectReference;
  abstract stringLiteral(key: object, bytes: readonly number[], at: Location): ObjectReference;
  abstract automaticObject(key: object, type: CType, scopeToken: object, at: Location, options?: MemoryAllocationOptions): ObjectReference;
  abstract releaseScope(scopeToken: object, at: Location): void;
  abstract element(ref: ObjectReference, index: number | bigint, at: Location): ObjectReference;
  abstract member(ref: ObjectReference, index: number, at: Location): ObjectReference;
  abstract dereference(pointer: CValue, at: Location): ObjectReference;
  abstract addressOf(ref: ObjectReference, pointerCType?: Extract<CType, { kind: 'pointer' }>): CValue;
  abstract decay(ref: ObjectReference): CValue;
  abstract pointerAdd(pointer: CValue, count: bigint, at: Location): CValue;
  abstract pointerDifference(left: CValue, right: CValue, at: Location): CValue;
  abstract pointerRelationalCompare(left: CValue, right: CValue, operator: string, at: Location): boolean;
  abstract assertAlive(pointer: CValue, at: Location): void;
  abstract formatPointer(pointer: CValue, at: Location): string;
  abstract pointerInteger(pointer: CValue, at: Location): bigint;
  abstract pointerFromInteger(value: bigint, type: CType, at: Location): CValue;
  abstract parsePointer(text: string, at: Location): CValue;
  abstract pointerEqual(left: CValue, right: CValue, at?: Location): boolean;
  abstract read(ref: ObjectReference, at: Location): CValue;
  abstract inspectScalar(ref: ObjectReference, at: Location): { readonly initialized: boolean; readonly value?: ObjectScalarValue };
  abstract inspectPointer(ref: ObjectReference, at: Location): PointerInspectionResult;
  abstract inspectArrayPointerElement(ref: ObjectReference, index: number, at: Location): PointerInspectionResult | undefined;
  abstract inspectArrayElement(ref: ObjectReference, index: number, at: Location): { readonly initialized: boolean; readonly value?: ObjectScalarValue } | undefined;
  abstract inspectAggregateScalar(ref: ObjectReference, memberIndex: number, at: Location): { readonly initialized: boolean; readonly value?: ObjectScalarValue };
  abstract inspectAggregatePointer(ref: ObjectReference, memberIndex: number, at: Location): PointerInspectionResult;
  protected abstract inspectPointerRepresentation(root: AllocationRoot, type: CType, byteOffset: number, size: number, nodeInitialized: boolean, zeroInitialized: boolean, nodeValue: ObjectScalarValue | undefined, at: Location): PointerInspectionResult;
  protected abstract inspectArithmeticRepresentation(root: AllocationRoot, type: CType, byteOffset: number, size: number, nodeInitialized: boolean, zeroInitialized: boolean, at: Location): { readonly initialized: boolean; readonly value?: ObjectScalarValue };
  abstract isReadOnly(ref: ObjectReference, at: Location): boolean;
  abstract inspectStringLiteral(ref: ObjectReference): readonly number[] | undefined;
  abstract write(ref: ObjectReference, value: CValue, at: Location, initializing?: boolean): CValue;
  abstract zeroInitialize(ref: ObjectReference, at: Location): void;
  protected abstract allocateRoot(type: CType, size: number, duration: StorageDuration, at: Location, raw: boolean, reservedNextBytes?: number, heapReservation?: AddressReservation, ignoredHeapFirstSlot?: bigint, options?: MemoryAllocationOptions): ObjectReference;
  protected abstract nextAllocationByteCount(size: number, at: Location): number;
  protected abstract validateAlignment(alignment: number, at: Location): void;
  protected abstract collectConstRanges(root: AllocationRoot, type: CType, offset: number, at: Location): void;
  protected abstract reservationSlotCount(size: number): bigint;
  protected abstract regionForDuration(duration: StorageDuration): { readonly start: bigint; readonly endExclusive: bigint };
  protected abstract extentsForDuration(duration: Exclude<StorageDuration, 'heap'>): Map<bigint, bigint>;
  protected abstract chooseSessionAddress(size: number, duration: Exclude<StorageDuration, 'heap'>, alignment: number): AddressReservation | undefined;
  protected abstract failRegionExhaustion(size: number, duration: Exclude<StorageDuration, 'heap'>, at: Location): never;
  protected abstract heapReservationAt(size: number, virtualBase: bigint, ignoredFirstSlot?: bigint): AddressReservation | undefined;
  protected abstract chooseHeapAddress(size: number, at: Location, ignoredFirstSlot?: bigint, alignment?: number): AddressReservation | undefined;
  protected abstract invalidateRoot(id: number, at: Location): void;
  protected abstract nodeFor(ref: ObjectReference, at: Location): RuntimeObject;
  protected abstract directStructMember(ref: ObjectReference, memberIndex: number, at: Location): { readonly parent: RuntimeObject; readonly root: AllocationRoot; readonly type: CType; readonly byteOffset: number; readonly zeroInitialized: boolean; };
  protected abstract child(parent: RuntimeObject, index: number, at: Location, member?: AggregateDefinition['members'][number]): ObjectReference;
  protected abstract reference(node: RuntimeObject, extra?: Partial<ObjectReference>): ObjectReference;
  protected abstract locate(root: AllocationRoot, byteOffset: number, type: CType, at: Location): RuntimeObject;
  protected abstract readSnapshot(node: RuntimeObject, at: Location): ObjectSnapshot;
  protected abstract snapshot(node: RuntimeObject, at: Location): ObjectSnapshot;
  protected abstract copyInitializationSnapshot(node: RuntimeObject, at: Location): ObjectSnapshot;
  protected abstract applyInitializationSnapshot(node: RuntimeObject, snapshot: ObjectSnapshot, at: Location): void;
  protected abstract applyInitializationShadows(root: AllocationRoot, at: Location): void;
  protected abstract restore(node: RuntimeObject, snapshot: ObjectSnapshot, at: Location): void;
  protected abstract activateContainingUnions(node: RuntimeObject, at: Location): void;
  protected abstract resetTree(node: RuntimeObject, zeroInitialized: boolean): void;
  protected abstract ensureWritable(node: RuntimeObject, at: Location, initializing?: boolean): void;
  protected abstract ensureEffectiveType(node: RuntimeObject, at: Location): void;
  protected abstract effectiveTypeCovers(effectiveType: CType, effectiveStart: number, effectiveEnd: number, accessStart: number, accessEnd: number, accessType: CType, at: Location): boolean;
  protected abstract typesMayAlias(left: CType, right: CType, at: Location, visited?: Set<string>): boolean;
  protected abstract aggregateContainsType(container: CType, target: CType, at: Location, visited: Set<string>): boolean;
  protected abstract recordEffectiveType(node: RuntimeObject, type: CType, at: Location): void;
  protected abstract bitFieldFor(node: RuntimeObject, at: Location): { readonly parent: RuntimeObject; readonly member: AggregateDefinition['members'][number]; } | undefined;
  protected abstract bitFieldPromotionType(type: CType, bitField: NonNullable<AggregateDefinition['members'][number]['bitField']>): CType;
  protected abstract readBitField(node: RuntimeObject, bitField: NonNullable<AggregateDefinition['members'][number]['bitField']>, at: Location): ObjectScalarValue;
  protected abstract writeBitField(node: RuntimeObject, bitField: NonNullable<AggregateDefinition['members'][number]['bitField']>, value: ObjectScalarValue, at: Location): bigint;
  protected abstract aggregate(type: CType, at: Location): AggregateDefinition;
  protected abstract alignment(type: CType, at: Location): number;
  protected abstract zeroValue(type: CType, at: Location): ObjectScalarValue;
  protected abstract rootFor(node: RuntimeObject, at: Location): AllocationRoot;
  protected abstract writeRepresentation(node: RuntimeObject, value: ObjectScalarValue, at: Location): void;
  protected abstract clearRepresentation(node: RuntimeObject, at: Location): void;
  protected abstract readScalar(node: RuntimeObject, at: Location): ObjectScalarValue;
  abstract copyablePointerValues(pointer: ObjectPointerValue, count: number, at: Location): readonly { readonly relativeOffset: number; readonly value: ObjectPointerValue; }[];
  abstract restoreCopiedPointerValues(pointer: ObjectPointerValue, count: number, values: readonly { readonly relativeOffset: number; readonly value: ObjectPointerValue }[], at: Location): void;
  abstract copyableEffectiveTypes(pointer: ObjectPointerValue, count: number, at: Location): readonly EffectiveTypeCopy[];
  abstract restoreCopiedEffectiveTypes(pointer: ObjectPointerValue, count: number, types: readonly EffectiveTypeCopy[], at: Location): void;
  protected abstract clearPointerProvenance(root: AllocationRoot, start: number, end: number): void;
  protected abstract invalidatePointerObjectCaches(root: AllocationRoot, start: number, end: number, preserveObjectId?: number): void;
  protected abstract readRepresentationByte(root: AllocationRoot, offset: number, at: Location): number;
  protected abstract leafAt(parent: RuntimeObject, offset: number, at: Location): RuntimeObject | undefined;
  protected abstract hasZeroInitializedAncestor(node: RuntimeObject): boolean;
  protected abstract hasInitializedDescendant(node: RuntimeObject): boolean;
  protected abstract encodeScalar(type: CType, value: ObjectScalarValue, at: Location): number[];
  protected abstract decodeScalar(type: CType, bytes: number[], at: Location): ObjectScalarValue;
  protected abstract toBytes(value: bigint, size: number): number[];
  protected abstract fromBytes(bytes: readonly number[]): bigint;
  protected abstract arrayIndex(pointer: ObjectPointerValue): number | undefined;
  protected abstract typeKey(type: CType): string;
  protected abstract get rawViews(): Map<number, Map<string, RuntimeObject>>;
}
