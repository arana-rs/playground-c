import { MemoryValues } from './values.ts';
import type { Location, ObjectScalarValue, ObjectSnapshot } from '../internal.ts';
import { aggregateType, isScalar, sameType } from '../type-system.ts';
import type { RuntimeObject, AllocationRoot } from './state.ts';

export abstract class MemorySnapshots extends MemoryValues {
  protected override readSnapshot(node: RuntimeObject, at: Location): ObjectSnapshot {
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

  protected override snapshot(node: RuntimeObject, at: Location): ObjectSnapshot { return this.readSnapshot(node, at); }

  protected override copyInitializationSnapshot(node: RuntimeObject, at: Location): ObjectSnapshot {
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

  protected override applyInitializationSnapshot(node: RuntimeObject, snapshot: ObjectSnapshot, at: Location): void {
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

  protected override applyInitializationShadows(root: AllocationRoot, at: Location): void {
    const views = this.rawViews.get(root.allocationId);
    if (!views) return;
    for (const range of root.effectiveTypes) {
      if (!range.initialization) continue;
      const view = [...views.values()].find((candidate) => candidate.alive && candidate.byteOffset === range.start &&
        candidate.size === range.end - range.start && sameType(candidate.type, range.type));
      if (view) this.applyInitializationSnapshot(view, range.initialization, at);
    }
  }

  protected override restore(node: RuntimeObject, snapshot: ObjectSnapshot, at: Location): void {
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

  protected override activateContainingUnions(node: RuntimeObject, at: Location): void {
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

  protected override resetTree(node: RuntimeObject, zeroInitialized: boolean): void {
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
}
