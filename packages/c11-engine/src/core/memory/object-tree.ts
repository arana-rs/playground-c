import { isCharacterType } from './state.ts';
import { MemoryAddressSpace } from './address-space.ts';
import { failure } from '../internal.ts';
import type { AggregateDefinition, CType, Location, ObjectReference } from '../internal.ts';
import { aggregateType, arrayOf, arrayType, isAggregate, isArray, isInteger, isPointer, sameType, sizeOfType, unqualifiedType } from '../type-system.ts';
import type { RuntimeObject, AllocationRoot, RuntimeObjectDescription, RuntimeObjectViewDescription } from './state.ts';

export abstract class MemoryObjectTree extends MemoryAddressSpace {

  /** Attach a resolved variably modified pointer type to its fixed-size pointer object. */
  override retypePointer(ref: ObjectReference, type: CType, at: Location): ObjectReference {
    const node = this.nodeFor(ref, at);
    if (!isPointer(node.type) || !isPointer(type) || sizeOfType(type, this.aggregates, at) !== node.size) {
      failure('TYPE_ERROR', 'A variably modified pointer must retain its pointer object size.', at);
    }
    node.type = type;
    return this.reference(node);
  }

  override describeObject(ref: ObjectReference, at: Location): RuntimeObjectDescription {
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
  override describeObjectView(ref: ObjectReference, at: Location): RuntimeObjectViewDescription {
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
    const bitField = this.bitFieldFor(node, at)?.member.bitField;
    const bitMask = bitField
      ? ((1n << BigInt(bitField.width)) - 1n) << BigInt(bitField.bitOffset)
      : undefined;
    return {
      objectId: node.id,
      allocationId: node.allocationId,
      duration: root.duration,
      addressVirtual: root.virtualBase + BigInt(node.byteOffset - root.byteOffset),
      size,
      ...(bitMask === undefined ? {} : { bitMask }),
    };
  }

  override rootReference(allocationId: number): ObjectReference | undefined {
    const root = this.roots.get(allocationId);
    return root?.alive ? this.reference(root) : undefined;
  }

  /** Return integer scalar views intersecting a byte range without reading them. */
  override integerObjectViewsInRange(allocationId: number, byteOffset: number, byteCount: number): readonly ObjectReference[] {
    const root = this.roots.get(allocationId);
    if (!root?.alive || !Number.isSafeInteger(byteOffset) || !Number.isSafeInteger(byteCount) || byteCount < 0) return [];
    const end = byteOffset + byteCount;
    if (!Number.isSafeInteger(end)) return [];
    return Object.freeze([...this.records.values()]
      .filter((node) => node.alive && node.allocationId === allocationId && isInteger(node.type) &&
        node.byteOffset < end && byteOffset < node.byteOffset + node.size)
      .map((node) => this.reference(node)));
  }

  override heapAggregateReferences(): readonly ObjectReference[] {
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

  override isAlive(ref: ObjectReference): boolean {
    const node = this.records.get(ref.objectId);
    return !!node && node.allocationId === ref.allocationId && node.alive && !!this.roots.get(node.allocationId)?.alive;
  }

  override findStaticObject(key: object): ObjectReference | undefined { return this.staticObjects.get(key); }

  override findAutomaticObject(key: object, scopeToken: object): ObjectReference | undefined {
    return this.automaticObjects.get(key)?.get(scopeToken);
  }

  override scopeObjectReferences(scopeToken: object): readonly ObjectReference[] {
    return (this.scopeObjects.get(scopeToken) ?? []).filter((ref) => this.isAlive(ref));
  }

  override element(ref: ObjectReference, index: number | bigint, at: Location): ObjectReference {
    const parent = this.nodeFor(ref, at);
    const array = arrayType(parent.type);
    if (!array) failure('INVALID_SUBSCRIPT', 'Subscript requires an array object.', at);
    const numericIndex = typeof index === 'bigint' ? Number(index) : index;
    if (!Number.isSafeInteger(numericIndex) || numericIndex < 0 || array.length === null || numericIndex >= array.length) {
      failure('ARRAY_BOUNDS', 'The index is outside the array bounds.', at);
    }
    return this.child(parent, numericIndex, at);
  }

  override member(ref: ObjectReference, index: number, at: Location): ObjectReference {
    const parent = this.nodeFor(ref, at);
    const aggregate = aggregateType(parent.type);
    if (!aggregate) failure('INVALID_MEMBER_ACCESS', 'Member access requires a struct or union.', at);
    const definition = this.aggregate(aggregate, at);
    const member = definition.members[index];
    if (!member) failure('UNKNOWN_MEMBER', `No member exists at index ${index}.`, at);
    if (member.bitField?.width === 0) failure('INVALID_MEMBER_ACCESS', 'An unnamed or zero-width bit-field is inaccessible.', at);
    return this.child(parent, index, at, member);
  }

  protected override nodeFor(ref: ObjectReference, at: Location): RuntimeObject {
    const node = this.records.get(ref.objectId);
    if (!node || node.allocationId !== ref.allocationId) failure('INACTIVE_OBJECT', 'The reference does not identify a live object.', at);
    const root = this.roots.get(node.allocationId);
    if (!node.alive || !root?.alive) failure('INACTIVE_OBJECT', 'The object lifetime has ended.', at);
    return node;
  }

  protected override directStructMember(ref: ObjectReference, memberIndex: number, at: Location): {
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

  protected override child(parent: RuntimeObject, index: number, at: Location, member?: AggregateDefinition['members'][number]): ObjectReference {
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

  protected override reference(node: RuntimeObject, extra: Partial<ObjectReference> = {}): ObjectReference {
    return {
      objectId: node.id, allocationId: node.allocationId, byteOffset: node.byteOffset, type: node.type,
      ...extra,
    };
  }

  protected override locate(root: AllocationRoot, byteOffset: number, type: CType, at: Location): RuntimeObject {
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
}
