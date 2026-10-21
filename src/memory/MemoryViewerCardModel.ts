import type { DebugArrayElementSnapshot } from '@playground/c11-engine/core';
import type {
  DebugAggregateSnapshot,
  DebugHeapObjectSnapshot,
  DebugPointerSnapshot,
  DebugScalarSnapshot,
  DebugStaticObjectSnapshot,
} from './useMemoryViewer.ts';
import {
  memoryViewerArrayElementPointerIdentity,
  memoryViewerPointerIdentity,
} from './pointerSnapshots.ts';
import type { MemoryViewerPointerIdentity } from './pointerSnapshots.ts';
import { truncateMemoryViewerScalarValue } from './scalarValue.ts';
import type { Translate } from '../i18n.tsx';

export interface MemoryViewerCardRecord {
  readonly id: number | null;
  readonly arrayElementKey: string | null;
  readonly arrayElementIndex: number | null;
  readonly aggregateMemberKey: string | null;
  readonly aggregateMemberName: string | null;
  readonly aggregateUnsupportedReason?: DebugAggregateSnapshot['members'][number]['unsupportedReason'] | 'pointer';
  readonly address: string;
  readonly size: number;
  readonly origin: string;
  readonly duration: DebugPointerSnapshot['duration'] | DebugAggregateSnapshot['duration'] | 'heap';
  readonly label: string;
  readonly typeLabel: string | null;
  readonly valueTitle: string;
  readonly uninitializedVisualLabel?: string;
  readonly valueContent: string;
  readonly initialized: boolean | null;
  readonly valueChanged: boolean;
  readonly isParameter: boolean;
  readonly isStringLiteral: boolean;
  readonly isHeapBlock: boolean;
  readonly isFreed?: boolean;
  readonly isArrayElement: boolean;
  readonly isPointer: boolean;
  readonly isPointerTarget: boolean;
  readonly pointerStatus: DebugPointerSnapshot['status'] | null;
  readonly pointerIdentity: MemoryViewerPointerIdentity | null;
}

export interface MemoryViewerScalarCardProps {
  record: MemoryViewerCardRecord;
  exiting?: boolean;
  fading?: boolean;
  onPointerHoverChange?: (pointerIdentity: MemoryViewerPointerIdentity, isHovered: boolean) => void;
  onPointerFocusChange?: (pointerIdentity: MemoryViewerPointerIdentity, isFocused: boolean) => void;
}

export interface MemoryViewerMetadataFooterProps {
  name: string;
  type: string | null;
  size: number;
  readOnly?: boolean;
  objectKind: 'scalar' | 'array' | 'aggregate';
  wrapperClassName?: string;
}

export function scalarCardRecord(
  scalar: DebugScalarSnapshot | DebugStaticObjectSnapshot,
  t: Translate,
  valueChanged = false,
): MemoryViewerCardRecord {
  const valueLabel = scalar.initialized ? scalar.displayValue : t('memoryViewer.uninitialized');
  return {
    id: scalar.id,
    arrayElementKey: null,
    arrayElementIndex: null,
    aggregateMemberKey: null,
    aggregateMemberName: null,
    address: scalar.address,
    size: scalar.size,
    origin: scalar.origin,
    duration: 'duration' in scalar ? scalar.duration : 'automatic',
    label: scalar.name ?? t('memoryViewer.stringLiteral'),
    typeLabel: scalar.type,
    valueTitle: valueLabel,
    valueContent: scalar.initialized ? truncateMemoryViewerScalarValue(scalar.displayValue) : '—',
    initialized: scalar.initialized,
    valueChanged,
    isParameter: scalar.origin === 'parameter',
    isStringLiteral: scalar.origin === 'string-literal',
    isHeapBlock: false,
    isArrayElement: false,
    isPointer: false,
    isPointerTarget: false,
    pointerStatus: null,
    pointerIdentity: null,
  };
}

function pointerValueTitle(pointer: {
  readonly initialized: boolean | null;
  readonly status: DebugPointerSnapshot['status'] | undefined;
  readonly displayValue: string;
  readonly target?: DebugPointerSnapshot['target'];
}, t: Translate): string {
  if (pointer.initialized !== true || pointer.status === 'uninitialized') {
    return t('memoryViewer.pointerTitle.uninitialized');
  }
  if (pointer.status === 'null') {
    return t('memoryViewer.pointerTitle.null', { address: pointer.displayValue });
  }
  if (pointer.status === 'live') {
    if (pointer.target && pointer.target.byteOffset !== 0) {
      return t('memoryViewer.pointerTitle.interior', { address: pointer.displayValue, offset: pointer.target.byteOffset });
    }
    return pointer.target
      ? t('memoryViewer.pointerTitle.liveNamed', { address: pointer.displayValue, name: pointer.target.name ?? '' })
      : t('memoryViewer.pointerTitle.live', { address: pointer.displayValue });
  }
  if (pointer.status === 'one-past') {
    return t('memoryViewer.pointerTitle.onePast', { address: pointer.displayValue });
  }
  if (pointer.status === 'dangling') {
    return t('memoryViewer.pointerTitle.dangling', { address: pointer.displayValue });
  }
  if (pointer.status === 'unmapped') {
    return t('memoryViewer.pointerTitle.unobserved', { address: pointer.displayValue });
  }
  return t('memoryViewer.pointerTitle.function', { address: pointer.displayValue });
}

export function pointerCardRecord(
  pointer: DebugPointerSnapshot,
  valueChanged: boolean,
  isPointerTarget: boolean,
  t: Translate,
): MemoryViewerCardRecord {
  const pointerValue = pointerCardValueRecord(pointer, t);
  return {
    id: pointer.id,
    arrayElementKey: null,
    arrayElementIndex: null,
    aggregateMemberKey: null,
    aggregateMemberName: null,
    address: pointer.address,
    size: pointer.size,
    origin: pointer.origin,
    duration: pointer.duration,
    label: pointer.name,
    typeLabel: pointer.type,
    ...pointerValue,
    valueChanged,
    isParameter: pointer.origin === 'parameter',
    isStringLiteral: false,
    isHeapBlock: false,
    isArrayElement: false,
    isPointer: true,
    isPointerTarget,
    pointerIdentity: memoryViewerPointerIdentity(pointer),
  };
}

export function pointerCardValueRecord(pointer: {
  readonly initialized: boolean | null;
  readonly status: DebugPointerSnapshot['status'] | undefined;
  readonly displayValue: string;
  readonly target?: DebugPointerSnapshot['target'];
}, t: Translate): Pick<MemoryViewerCardRecord,
  'valueTitle' | 'uninitializedVisualLabel' | 'valueContent' | 'initialized' | 'pointerStatus'> {
  const isUninitialized = !pointer.initialized || pointer.status === 'uninitialized';
  const valueTitle = pointerValueTitle(pointer, t);
  return {
    valueTitle,
    uninitializedVisualLabel: isUninitialized ? t('memoryViewer.uninitialized') : undefined,
    valueContent: isUninitialized
      ? '—'
      : pointer.status === 'null' ? 'NULL' : truncateMemoryViewerScalarValue(pointer.displayValue),
    initialized: !isUninitialized,
    pointerStatus: pointer.status ?? null,
  };
}

function arrayElementContent(elementType: string, displayValue: string): string {
  if (!/^(?:signed |unsigned )?char$/.test(elementType)) return displayValue;
  if (displayValue.length >= 2 && displayValue.startsWith("'") && displayValue.endsWith("'")) {
    return displayValue.slice(1, -1);
  }
  return displayValue;
}

interface MemoryViewerArrayElementCardContext {
  readonly rootId: number;
  readonly name: string;
  readonly origin: string;
  readonly duration: MemoryViewerCardRecord['duration'];
  readonly elementSize: number;
}

export function arrayElementCardRecord(
  array: MemoryViewerArrayElementCardContext,
  element: DebugArrayElementSnapshot,
  valueChanged: boolean,
  t: Translate,
  isPointerTarget = false,
): MemoryViewerCardRecord {
  const isPointer = element.kind === 'pointer';
  const pointerValue = isPointer
    ? pointerCardValueRecord({
      initialized: element.initialized,
      status: element.pointerStatus,
      displayValue: element.displayValue,
      target: element.target,
    }, t)
    : null;
  const valueTitle = pointerValue?.valueTitle ?? (element.initialized
    ? element.valueTruncated ? t('memoryViewer.truncatedValue', { value: element.displayValue }) : element.displayValue
    : t('memoryViewer.uninitialized'));
  const valueContent = pointerValue?.valueContent ?? (element.initialized
    ? truncateMemoryViewerScalarValue(arrayElementContent(element.type, element.displayValue))
    : '—');
  return {
    id: null,
    arrayElementKey: element.key,
    arrayElementIndex: element.index,
    aggregateMemberKey: null,
    aggregateMemberName: null,
    address: element.address,
    size: array.elementSize,
    origin: array.origin,
    duration: array.duration,
    label: `${array.name}[${element.index}]`,
    typeLabel: element.type,
    ...pointerValue,
    valueTitle,
    valueContent,
    initialized: pointerValue?.initialized ?? element.initialized,
    uninitializedVisualLabel: pointerValue?.uninitializedVisualLabel,
    valueChanged,
    isParameter: false,
    isStringLiteral: array.origin === 'string-literal',
    isHeapBlock: false,
    isArrayElement: true,
    isPointer,
    isPointerTarget,
    pointerStatus: pointerValue?.pointerStatus ?? null,
    pointerIdentity: isPointer
      ? memoryViewerArrayElementPointerIdentity(array.rootId, element.index)
      : null,
  };
}

export function heapCardRecord(
  block: DebugHeapObjectSnapshot,
  t: Translate,
  aliasLabel?: string,
  isFreed = false,
): MemoryViewerCardRecord {
  return {
    id: block.id,
    arrayElementKey: null,
    arrayElementIndex: null,
    aggregateMemberKey: null,
    aggregateMemberName: null,
    address: block.address,
    size: block.size,
    origin: block.origin,
    duration: 'heap',
    label: aliasLabel ?? t('memoryViewer.heapBlock'),
    typeLabel: 'heap block',
    valueTitle: isFreed ? t('memoryViewer.freed') : t('memoryViewer.unknownContents'),
    valueContent: isFreed ? t('memoryViewer.freed') : '?',
    initialized: null,
    valueChanged: false,
    isParameter: false,
    isStringLiteral: false,
    isHeapBlock: true,
    isFreed,
    isArrayElement: false,
    isPointer: false,
    isPointerTarget: false,
    pointerStatus: null,
    pointerIdentity: null,
  };
}
