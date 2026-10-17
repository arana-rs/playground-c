import type { DebugArraySnapshot, DebugStaticObjectSnapshot } from '@playground/c11-engine/core';

type DebugArrayElementSnapshot = DebugArraySnapshot['elements'][number];

/** Compare a bounded array DTO, including its at-most-ten element DTOs. */
export function sameMemoryViewerArraySnapshot(
  left: DebugArraySnapshot,
  right: DebugArraySnapshot,
): boolean {
  return left.rootId === right.rootId
    && left.name === right.name
    && left.origin === right.origin
    && left.duration === right.duration
    && left.region === right.region
    && left.frameId === right.frameId
    && left.scopeId === right.scopeId
    && left.type === right.type
    && left.elementType === right.elementType
    && left.address === right.address
    && left.size === right.size
    && left.length === right.length
    && left.readOnly === right.readOnly
    && left.status === right.status
    && left.elements.length === right.elements.length
    && left.elements.every((element, index) => sameArrayElement(element, right.elements[index]!));
}

export function sameArrayElement(left: DebugArrayElementSnapshot, right: DebugArrayElementSnapshot): boolean {
  return left.key === right.key
    && left.index === right.index
    && left.address === right.address
    && left.type === right.type
    && left.initialized === right.initialized
    && left.displayValue === right.displayValue
    && left.valueTruncated === right.valueTruncated;
}

/** Detach and freeze the bounded children before retaining a Worker snapshot in history. */
export function cloneMemoryViewerArraySnapshot(snapshot: DebugArraySnapshot): DebugArraySnapshot {
  const elements = Object.freeze(snapshot.elements.map(element => Object.freeze({ ...element })));
  return Object.freeze({ ...snapshot, elements });
}

/** Find only live cells whose initialization state or complete display value changed. */
export function findMemoryViewerChangedArrayElementKeys(
  previous: readonly DebugArraySnapshot[],
  current: readonly DebugArraySnapshot[],
): readonly string[] {
  const previousByKey = new Map<string, DebugArrayElementSnapshot>();
  for (const array of previous) {
    for (const element of array.elements) previousByKey.set(element.key, element);
  }

  return current.flatMap(array => array.elements.flatMap(element => {
    const earlier = previousByKey.get(element.key);
    return earlier && (earlier.initialized !== element.initialized
      || earlier.displayValue !== element.displayValue)
      ? [element.key]
      : [];
  }));
}

/** String literals now belong to the array view, even when the bounded inspector omits one. */
export function filterMemoryViewerStaticScalars(
  staticObjects: readonly DebugStaticObjectSnapshot[],
  arrays: readonly DebugArraySnapshot[],
): readonly DebugStaticObjectSnapshot[] {
  const arrayRootIds = new Set(arrays.map(array => array.rootId));
  return staticObjects.filter(object => {
    if (object.origin === 'string-literal') return false;
    return !arrayRootIds.has(object.id);
  });
}
