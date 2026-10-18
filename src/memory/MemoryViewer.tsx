import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, SyntheticEvent } from 'react';
import { Button } from '../components/arc/button/button.tsx';
import type { DebugArrayElementSnapshot } from '@playground/c11-engine/core';
import { ConsolePanel } from '../components/ConsolePanel.tsx';
import { SelectedFileTab } from '../components/SelectedFileTab.tsx';
import { CodeEditor } from '../editor/CodeEditor.tsx';
import { formatConsoleSegments } from '../execution/useRunner.ts';
import type { ConsoleEntry, ConsoleStatusTone } from '../execution/useRunner.ts';
import type { RunConfiguration } from '../execution/configuration.ts';
import { useMemoryViewer } from './useMemoryViewer.ts';
import { hasDirectStdioInclude } from './stdioInclude.ts';
import type {
  DebugAggregateSnapshot,
  DebugHeapObjectSnapshot,
  DebugArraySnapshot,
  DebugPointerSnapshot,
  DebugScalarSnapshot,
  DebugStaticObjectSnapshot,
  MemoryViewerActiveScope,
  MemoryViewerLifecycleBatch,
} from './useMemoryViewer.ts';
import {
  MEMORY_VIEWER_SCOPE_NAME_MAX_CHARACTERS,
  isForBodyMemoryViewerScope,
  truncateMemoryViewerScopeName,
} from './scopeName.ts';
import { truncateMemoryViewerScalarValue } from './scalarValue.ts';
import {
  filterMemoryViewerStaticScalars,
  findMemoryViewerChangedArrayElementKeys,
} from './arraySnapshots.ts';
import { findMemoryViewerChangedAggregateMemberKeys, hasAnonymousAggregateMember } from './aggregateSnapshots.ts';
import {
  findMemoryViewerChangedPointerIds,
  memoryViewerArrayElementPointerIdentity,
  memoryViewerPointerIdentityKey,
  memoryViewerPointerIdentity,
  resolveMemoryViewerPointerTarget,
  sameMemoryViewerPointerIdentity,
} from './pointerSnapshots.ts';
import type { MemoryViewerPointerIdentity, MemoryViewerPointerTarget } from './pointerSnapshots.ts';
import {
  chooseMemoryViewerStackFocusId,
  compareMemoryViewerStackSnapshots,
  findMemoryViewerChangedScalarIds,
  findMemoryViewerFunctionRootScopeIds,
  findEntrypointMainRootScopeId,
  mergeExitedItemsInPreviousOrder,
} from './stackTransition.ts';
import { MemoryViewerExitCleanupTimer, readMemoryViewerExitDuration } from './exitCleanup.ts';
import {
  chooseMemoryViewerHeapFocusId,
  compareMemoryViewerHeapObjects,
  mergeMemoryViewerHeapViews,
  mergeMemoryViewerHeapObjects,
} from './heapSnapshots.ts';
import { useStackHorizontalScroll } from './useStackHorizontalScroll.ts';
import { useI18n } from '../i18n.tsx';
import type { Translate } from '../i18n.tsx';

interface MemoryViewerProps {
  source: string;
  configuration: RunConfiguration;
  onClose: () => void;
}

function getStatusLabel(
  status: ReturnType<typeof useMemoryViewer>['status'],
  isPlaying: boolean,
  t: Translate,
) {
  switch (status) {
    case 'starting': return t('memoryViewer.status.preparing');
    case 'paused': return isPlaying ? t('memoryViewer.status.playing') : t('memoryViewer.status.paused');
    case 'running': return isPlaying ? t('memoryViewer.status.playing') : t('memoryViewer.status.stepping');
    case 'waiting-input': return t('memoryViewer.status.waitingInput');
    case 'terminated': return t('memoryViewer.status.programEnded');
    case 'cancelled': return t('memoryViewer.status.stopped');
    case 'error': return t('memoryViewer.status.error');
    case 'limit': return t('memoryViewer.status.limit');
  }
}

function getDebugConsoleStatus(
  status: ReturnType<typeof useMemoryViewer>['status'],
  isPlaying: boolean,
  isViewingHistory: boolean,
  inputRequestId: number | null,
  t: Translate,
): { label: string; tone: ConsoleStatusTone } {
  if (status === 'cancelled') return { label: t('memoryViewer.status.stopped'), tone: 'cancelled' };
  if (isViewingHistory) return { label: t('memoryViewer.status.historySelected'), tone: 'ready' };
  if (inputRequestId !== null || status === 'waiting-input') return { label: t('memoryViewer.status.waitingInput'), tone: 'waiting' };
  if (status === 'starting') return { label: t('memoryViewer.status.preparing'), tone: 'running' };
  if (status === 'running' || (status === 'paused' && isPlaying)) return { label: t('memoryViewer.status.stepping'), tone: 'running' };
  if (status === 'terminated') return { label: t('memoryViewer.status.finished'), tone: 'finished' };
  if (status === 'error') return { label: t('memoryViewer.status.error'), tone: 'error' };
  if (status === 'limit') return { label: t('memoryViewer.status.limitReached'), tone: 'stopped' };
  return { label: t('memoryViewer.status.paused'), tone: 'ready' };
}

type MemoryRegion = 'static' | 'stack' | 'heap';
const MEMORY_VIEWER_MODES = [
  { value: 'minimal' },
  { value: 'normal' },
  { value: 'debug' },
] as const;
type MemoryViewerMode = (typeof MEMORY_VIEWER_MODES)[number]['value'];

interface MemoryViewerRegionsProps {
  mode: MemoryViewerMode;
  hasUsedHeap: boolean;
  hasHeapAllocationCalls: boolean;
  lifecycle: MemoryViewerLifecycleBatch | null;
  activeScopes: readonly MemoryViewerActiveScope[];
  heapObjects: readonly DebugHeapObjectSnapshot[];
  arrays: readonly DebugArraySnapshot[];
  omittedArrayObjects: number;
  aggregates: readonly DebugAggregateSnapshot[];
  omittedAggregateObjects: number;
  stackScalars: readonly DebugScalarSnapshot[];
  pointers: readonly DebugPointerSnapshot[];
  staticObjects: readonly DebugStaticObjectSnapshot[];
  stepIndex: number;
  status: ReturnType<typeof useMemoryViewer>['status'];
}

interface MemoryViewerCardRecord {
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
  readonly isArrayElement: boolean;
  readonly isPointer: boolean;
  readonly isPointerTarget: boolean;
  readonly pointerStatus: DebugPointerSnapshot['status'] | null;
  readonly pointerIdentity: MemoryViewerPointerIdentity | null;
}

type MemoryViewerStackObject =
  | { readonly id: number; readonly kind: 'scalar'; readonly snapshot: DebugScalarSnapshot }
  | { readonly id: number; readonly kind: 'pointer'; readonly snapshot: DebugPointerSnapshot }
  | { readonly id: number; readonly kind: 'array'; readonly snapshot: DebugArraySnapshot }
  | { readonly id: number; readonly kind: 'aggregate'; readonly snapshot: DebugAggregateSnapshot };

type MemoryViewerStaticObject =
  | { readonly id: number; readonly kind: 'scalar'; readonly snapshot: DebugStaticObjectSnapshot }
  | { readonly id: number; readonly kind: 'pointer'; readonly snapshot: DebugPointerSnapshot }
  | { readonly id: number; readonly kind: 'array'; readonly snapshot: DebugArraySnapshot }
  | { readonly id: number; readonly kind: 'aggregate'; readonly snapshot: DebugAggregateSnapshot };

function stackMemoryObjects(
  scalars: readonly DebugScalarSnapshot[],
  arrays: readonly DebugArraySnapshot[],
  pointers: readonly DebugPointerSnapshot[] = [],
  aggregates: readonly DebugAggregateSnapshot[] = [],
): MemoryViewerStackObject[] {
  return [
    ...scalars.map(snapshot => ({ id: snapshot.id, kind: 'scalar' as const, snapshot })),
    ...pointers.filter(snapshot => snapshot.region === 'stack').map(snapshot => ({ id: snapshot.id, kind: 'pointer' as const, snapshot })),
    ...arrays.map(snapshot => ({ id: snapshot.rootId, kind: 'array' as const, snapshot })),
    ...aggregates.filter(snapshot => snapshot.region === 'stack').map(snapshot => ({ id: snapshot.viewId ?? snapshot.rootId, kind: 'aggregate' as const, snapshot })),
  ].sort((left, right) => left.id - right.id);
}

function staticMemoryObjects(
  scalars: readonly DebugStaticObjectSnapshot[],
  arrays: readonly DebugArraySnapshot[],
  pointers: readonly DebugPointerSnapshot[] = [],
  aggregates: readonly DebugAggregateSnapshot[] = [],
): MemoryViewerStaticObject[] {
  return [
    ...scalars.map(snapshot => ({ id: snapshot.id, kind: 'scalar' as const, snapshot })),
    ...pointers.filter(snapshot => snapshot.region === 'static').map(snapshot => ({ id: snapshot.id, kind: 'pointer' as const, snapshot })),
    ...arrays.map(snapshot => ({ id: snapshot.rootId, kind: 'array' as const, snapshot })),
    ...aggregates.filter(snapshot => snapshot.region === 'static').map(snapshot => ({ id: snapshot.viewId ?? snapshot.rootId, kind: 'aggregate' as const, snapshot })),
  ].sort((left, right) => left.id - right.id);
}

interface MemoryViewerScalarCardProps {
  record: MemoryViewerCardRecord;
  exiting?: boolean;
  fading?: boolean;
  onPointerHoverChange?: (pointerIdentity: MemoryViewerPointerIdentity, isHovered: boolean) => void;
  onPointerFocusChange?: (pointerIdentity: MemoryViewerPointerIdentity, isFocused: boolean) => void;
}

interface MemoryViewerMetadataFooterProps {
  name: string;
  type: string | null;
  size: number;
  readOnly?: boolean;
  objectKind: 'scalar' | 'array' | 'aggregate';
  wrapperClassName?: string;
}

interface MemoryViewerExitPresentation {
  readonly stepIndex: number;
  readonly deletedScalars: readonly DebugScalarSnapshot[];
  readonly deletedPointers: readonly DebugPointerSnapshot[];
  readonly deletedArrays: readonly DebugArraySnapshot[];
  readonly deletedAggregates: readonly DebugAggregateSnapshot[];
  readonly exitedScopes: readonly MemoryViewerActiveScope[];
  readonly previousStackObjectIds: readonly number[];
  readonly previousScopeIds: readonly number[];
  readonly focusId: number | null;
  readonly phase: 'waiting' | 'fading';
}

interface MemoryViewerHeapExitPresentation {
  readonly stepIndex: number;
  readonly deletedObjects: readonly DebugHeapObjectSnapshot[];
  readonly previousObjectIds: readonly number[];
  readonly focusId: number | null;
  readonly phase: 'waiting' | 'fading';
}

interface MemoryViewerValueChangePresentation {
  readonly stepIndex: number;
  readonly stackScalarIds: readonly number[];
  readonly stackPointerIds: readonly number[];
  readonly staticObjectIds: readonly number[];
  readonly staticPointerIds: readonly number[];
  readonly arrayElementKeys: readonly string[];
  readonly aggregateMemberKeys: readonly string[];
}

const EMPTY_EXIT_PRESENTATION: MemoryViewerExitPresentation = {
  stepIndex: -1,
  deletedScalars: [],
  deletedPointers: [],
  deletedArrays: [],
  deletedAggregates: [],
  exitedScopes: [],
  previousStackObjectIds: [],
  previousScopeIds: [],
  focusId: null,
  phase: 'waiting',
};

const EMPTY_HEAP_EXIT_PRESENTATION: MemoryViewerHeapExitPresentation = {
  stepIndex: -1,
  deletedObjects: [],
  previousObjectIds: [],
  focusId: null,
  phase: 'waiting',
};

const EMPTY_VALUE_CHANGE_PRESENTATION: MemoryViewerValueChangePresentation = {
  stepIndex: -1,
  stackScalarIds: [],
  stackPointerIds: [],
  staticObjectIds: [],
  staticPointerIds: [],
  arrayElementKeys: [],
  aggregateMemberKeys: [],
};

const scopeNameFrameStyle = {
  '--memory-viewer-scope-name-height': `calc(${MEMORY_VIEWER_SCOPE_NAME_MAX_CHARACTERS}ch + 10px)`,
} as CSSProperties & { '--memory-viewer-scope-name-height': string };

function isOutsideDialogBounds(dialog: HTMLDialogElement, clientX: number, clientY: number) {
  const bounds = dialog.getBoundingClientRect();
  return clientX < bounds.left || clientX >= bounds.right || clientY < bounds.top || clientY >= bounds.bottom;
}

function scalarCardRecord(
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

function pointerCardRecord(
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

function pointerCardValueRecord(pointer: {
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

function arrayElementCardRecord(
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

function heapCardRecord(block: DebugHeapObjectSnapshot, t: Translate): MemoryViewerCardRecord {
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
    label: t('memoryViewer.heapBlock'),
    typeLabel: 'heap block',
    valueTitle: t('memoryViewer.unknownContents'),
    valueContent: '?',
    initialized: null,
    valueChanged: false,
    isParameter: false,
    isStringLiteral: false,
    isHeapBlock: true,
    isArrayElement: false,
    isPointer: false,
    isPointerTarget: false,
    pointerStatus: null,
    pointerIdentity: null,
  };
}

function MemoryViewerMetadataFooter({ name, type, size, readOnly = false, objectKind, wrapperClassName }: MemoryViewerMetadataFooterProps) {
  const { t } = useI18n();
  const contents = (
    <>
      <span className={`memory-viewer-object-name memory-viewer-${objectKind}-name`} title={name}>{name}</span>
      <span
        className="memory-viewer-object-metadata"
        title={wrapperClassName ? `${type ?? t('memoryViewer.unknown')} · ${size} B${readOnly ? ` · ${t('memoryViewer.readOnly')}` : ''}` : undefined}
      >
        {type ?? t('memoryViewer.unknown')} · {size} B{readOnly ? ` · ${t('memoryViewer.readOnly')}` : ''}
      </span>
    </>
  );

  return wrapperClassName ? <div className={wrapperClassName}>{contents}</div> : contents;
}

function MemoryViewerScalarCard({
  record,
  exiting = false,
  fading = false,
  onPointerHoverChange,
  onPointerFocusChange,
}: MemoryViewerScalarCardProps) {
  const { t } = useI18n();
  const accessibleLabel = [
    record.label,
    record.typeLabel ? `(${record.typeLabel})` : null,
    record.isParameter ? t('memoryViewer.parameter') : null,
    record.duration === 'thread-local' ? t('memoryViewer.threadLocalDuration') : null,
    t('memoryViewer.address', { address: record.address }),
    record.valueTitle,
    record.isPointerTarget ? t('memoryViewer.pointerTarget') : null,
    record.valueChanged ? t('memoryViewer.changedValue') : null,
    record.isHeapBlock ? t('memoryViewer.sizeBytes', { size: record.size }) : null,
    exiting ? t('memoryViewer.exitingNode') : null,
  ].filter(Boolean).join(', ');
  const pointerIdentity = record.isPointer ? record.pointerIdentity : null;
  const isAggregateMember = record.aggregateMemberKey !== null;

  return (
    <div
      className={`memory-viewer-scalar${record.isParameter ? ' memory-viewer-scalar--parameter' : ''}${record.isStringLiteral ? ' memory-viewer-scalar--string-literal' : ''}${record.isHeapBlock ? ' memory-viewer-scalar--heap-block' : ''}${record.isArrayElement ? ' memory-viewer-scalar--array-element' : ''}${isAggregateMember ? ' memory-viewer-scalar--aggregate-member' : ''}${record.isPointer ? ' memory-viewer-scalar--pointer' : ''}${record.pointerStatus === 'null' ? ' memory-viewer-scalar--pointer-null' : ''}${record.isPointerTarget ? ' memory-viewer-scalar--pointer-target' : ''}${record.initialized === false ? ' memory-viewer-scalar--uninitialized' : ''}${record.valueChanged ? ' memory-viewer-scalar--value-changed' : ''}${exiting ? ' memory-viewer-scalar--exiting' : ''}${fading ? ' memory-viewer-scalar--fading' : ''}`}
      data-memory-viewer-scalar-id={record.id ?? undefined}
      data-memory-viewer-array-element-key={record.arrayElementKey ?? undefined}
      data-memory-viewer-aggregate-field-key={record.aggregateMemberKey ?? undefined}
      data-memory-viewer-aggregate-field-name={record.aggregateMemberName ?? undefined}
      data-origin={record.origin}
      data-duration={record.duration}
      data-initialized={record.initialized === null ? undefined : String(record.initialized)}
      data-pointer-status={record.pointerStatus ?? undefined}
      data-value-changed={record.valueChanged ? 'true' : undefined}
      data-pointer-target={record.isPointerTarget ? 'true' : undefined}
      tabIndex={record.isArrayElement || record.isPointer ? 0 : undefined}
      onMouseEnter={pointerIdentity === null ? undefined : () => onPointerHoverChange?.(pointerIdentity, true)}
      onMouseLeave={pointerIdentity === null ? undefined : () => onPointerHoverChange?.(pointerIdentity, false)}
      onFocus={pointerIdentity === null ? undefined : () => onPointerFocusChange?.(pointerIdentity, true)}
      onBlur={pointerIdentity === null ? undefined : () => onPointerFocusChange?.(pointerIdentity, false)}
      role="group"
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      {!record.isArrayElement && !isAggregateMember && (
        <span className="memory-viewer-scalar-address" title={record.address}>
          <span className="memory-viewer-scalar-address-value">{record.address}</span>
        </span>
      )}
      <span
        className="memory-viewer-scalar-value"
        title={record.valueTitle}
        aria-label={t(record.isHeapBlock ? 'memoryViewer.contents' : 'memoryViewer.value', { value: record.valueTitle })}
      >
        {record.initialized === false ? (
          <span className="memory-viewer-scalar-uninitialized" aria-hidden="true">
            <span className="memory-viewer-scalar-uninitialized-mark">{record.valueContent}</span>
            <span className="memory-viewer-scalar-uninitialized-label">
              {record.uninitializedVisualLabel ?? record.valueTitle}
            </span>
          </span>
        ) : record.aggregateUnsupportedReason ? (
          <span className="memory-viewer-aggregate-member-placeholder" title={record.valueTitle}>
            {record.aggregateUnsupportedReason === 'array'
              ? 'array'
              : record.aggregateUnsupportedReason === 'flexible-array' ? 'FAM'
                : record.aggregateUnsupportedReason === 'pointer' ? 'pointer' : 'aggregate'}
          </span>
        ) : record.valueContent}
        {record.valueChanged && <span className="memory-viewer-scalar-change-marker" aria-hidden="true">Δ</span>}
        {record.isArrayElement && (
          <span className="memory-viewer-array-index" aria-hidden="true">[{record.arrayElementIndex}]</span>
        )}
        {isAggregateMember && (
          <span className="memory-viewer-aggregate-field-name" aria-hidden="true">
            {record.aggregateMemberName || t('memoryViewer.anonymousMember')}
          </span>
        )}
      </span>
      {!record.isArrayElement && !isAggregateMember && (
        <MemoryViewerMetadataFooter
          name={record.label}
          type={record.typeLabel}
          size={record.size}
          objectKind="scalar"
        />
      )}
    </div>
  );
}

interface MemoryViewerArrayBlockProps {
  array: DebugArraySnapshot;
  changedElementKeys: ReadonlySet<string>;
  pointerTargetElementKey?: string | null;
  exiting?: boolean;
  fading?: boolean;
  onPointerHoverChange?: (pointerIdentity: MemoryViewerPointerIdentity, isHovered: boolean) => void;
  onPointerFocusChange?: (pointerIdentity: MemoryViewerPointerIdentity, isFocused: boolean) => void;
}

function arrayStatusMessage(array: DebugArraySnapshot, t: Translate): string | null {
  switch (array.status) {
    case 'available': return null;
    case 'too-many-elements': return t('memoryViewer.maxElements');
    case 'multidimensional': return t('memoryViewer.arrayPending');
    case 'unsupported-element-type': return t('memoryViewer.elementTypePending');
  }
}

export function MemoryViewerArrayBlock({
  array,
  changedElementKeys,
  pointerTargetElementKey = null,
  exiting = false,
  fading = false,
  onPointerHoverChange,
  onPointerFocusChange,
}: MemoryViewerArrayBlockProps) {
  const { t } = useI18n();
  const name = array.name ?? t('memoryViewer.stringLiteral');
  const accessibleLabel = [
    name,
    t('memoryViewer.typeLabel', { type: array.type }),
    t('memoryViewer.arrayLength', { length: array.length }),
    array.duration === 'thread-local' ? t('memoryViewer.durationLabel', { duration: 'thread-local' }) : null,
    t('memoryViewer.address', { address: array.address }),
    t('memoryViewer.sizeBytes', { size: array.size }),
    array.readOnly ? t('memoryViewer.readOnlyLabel') : null,
  ].filter(Boolean).join(', ');
  const placeholder = arrayStatusMessage(array, t);
  return (
    <div
      className={`memory-viewer-array${array.readOnly ? ' memory-viewer-array--readonly' : ''}${exiting ? ' memory-viewer-array--exiting' : ''}${fading ? ' memory-viewer-array--fading' : ''}`}
      data-memory-viewer-array-id={array.rootId}
      data-memory-viewer-scalar-id={array.region === 'stack' ? array.rootId : undefined}
      data-origin={array.origin}
      data-duration={array.duration}
      data-read-only={array.readOnly ? 'true' : undefined}
      role="group"
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      <div className="memory-viewer-array-body">
        {placeholder === null ? (
          <ol className="memory-viewer-array-cells" aria-label={t('memoryViewer.elementsOf', { name })}>
            {array.elements.map(element => (
              <li key={element.key}>
                <MemoryViewerScalarCard
                  record={arrayElementCardRecord(
                    {
                      rootId: array.rootId,
                      name: array.name ?? t('memoryViewer.stringLiteral'),
                      origin: array.origin,
                      duration: array.duration,
                      elementSize: array.length > 0 ? Math.max(1, Math.floor(array.size / array.length)) : 1,
                    },
                    element,
                    changedElementKeys.has(element.key),
                    t,
                    element.key === pointerTargetElementKey,
                  )}
                  onPointerHoverChange={onPointerHoverChange}
                  onPointerFocusChange={onPointerFocusChange}
                />
                <span
                  className="memory-viewer-scalar-address memory-viewer-array-cell-address"
                  title={element.address}
                  aria-hidden="true"
                >
                  <span className="memory-viewer-scalar-address-value">{element.address}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="memory-viewer-array-placeholder" role="status">{placeholder}</div>
        )}
        <MemoryViewerMetadataFooter
          name={name}
          type={array.type}
          size={array.size}
          readOnly={array.readOnly}
          objectKind="array"
        />
      </div>
    </div>
  );
}

function aggregateStatusMessage(aggregate: DebugAggregateSnapshot, t: Translate): string | null {
  switch (aggregate.status) {
    case 'available': return null;
    case 'too-many-members': return t('memoryViewer.maxMembers');
    case 'unsupported-union': return t('memoryViewer.unionPending');
  }
}

function aggregateMemberCardRecord(
  aggregate: DebugAggregateSnapshot,
  member: DebugAggregateSnapshot['members'][number],
  valueChanged: boolean,
  isPointerTarget: boolean,
  t: Translate,
): MemoryViewerCardRecord {
  const isPointer = member.kind === 'pointer';
  const isUnsupported = member.kind === 'unsupported' || isPointer;
  const isUninitialized = !isUnsupported && (member.initialized === false || member.pointerStatus === 'uninitialized');
  const reasonLabel = isPointer
    ? t('memoryViewer.pendingPointerField')
    : member.unsupportedReason === 'array'
      ? t('memoryViewer.pendingArrayField')
      : member.unsupportedReason === 'flexible-array' ? t('memoryViewer.flexibleArrayMember') : t('memoryViewer.pendingAggregateField');
  const bitRange = member.bitWidth === undefined || member.bitOffset === undefined
    ? null
    : `${member.bitOffset}–${member.bitOffset + member.bitWidth - 1}`;
  const valueTitle = isUnsupported
    ? member.flexibleArray
      ? t('memoryViewer.flexibleArrayDetails', {
        reason: reasonLabel,
        length: member.flexibleArray.length,
        capacity: member.flexibleArray.capacityBytes,
        elementSize: member.flexibleArray.elementSize,
        offset: member.offset,
      })
      : t('memoryViewer.memberDetails', { reason: reasonLabel, offset: member.offset, size: member.size })
    : member.bitWidth !== undefined
      ? t('memoryViewer.bitField', {
        value: member.initialized === true ? member.displayValue ?? '?' : t('memoryViewer.uninitialized'),
        width: member.bitWidth,
        positions: bitRange === null ? '' : t('memoryViewer.bitPositions', { positions: bitRange }),
        unitSize: member.storageUnitSize ?? member.size,
        offset: member.offset,
      })
      : member.initialized === true
        ? member.displayValue ?? '?'
        : t('memoryViewer.uninitialized');
  const valueContent = isUninitialized || isUnsupported
    ? '—'
    : truncateMemoryViewerScalarValue(member.displayValue ?? '?');
  return {
    id: null,
    arrayElementKey: null,
    arrayElementIndex: null,
    aggregateMemberKey: member.key,
    aggregateMemberName: member.name,
    aggregateUnsupportedReason: isPointer ? 'pointer' : member.kind === 'unsupported' ? member.unsupportedReason : undefined,
    address: member.address,
    size: member.size,
    origin: aggregate.origin,
    duration: aggregate.duration,
    label: member.name || t('memoryViewer.anonymousMember'),
    typeLabel: member.type,
    valueTitle,
    uninitializedVisualLabel: isUninitialized ? t('memoryViewer.uninitialized') : undefined,
    valueContent,
    initialized: isUnsupported ? null : member.initialized,
    valueChanged,
    isParameter: false,
    isStringLiteral: false,
    isHeapBlock: false,
    isArrayElement: false,
    isPointer: false,
    isPointerTarget: !isPointer && isPointerTarget,
    pointerStatus: null,
    pointerIdentity: null,
  };
}

function aggregateFlexibleArrayElementCardRecord(
  aggregate: DebugAggregateSnapshot,
  member: DebugAggregateSnapshot['members'][number],
  element: DebugArrayElementSnapshot,
  t: Translate,
): MemoryViewerCardRecord {
  const flexibleArray = member.flexibleArray;
  if (!flexibleArray) throw new Error('Expected a flexible array member snapshot.');
  return arrayElementCardRecord({
    rootId: aggregate.rootId,
    name: `${aggregate.name ?? aggregate.type}.${member.name}`,
    origin: aggregate.origin,
    duration: aggregate.duration,
    elementSize: flexibleArray.elementSize,
  }, element, false, t);
}

function flexibleArrayStatusMessage(status: NonNullable<DebugAggregateSnapshot['members'][number]['flexibleArray']>['status'], t: Translate): string | null {
  switch (status) {
    case 'available':
    case 'too-many-elements': return null;
    case 'multidimensional': return t('memoryViewer.arrayPending');
    case 'unsupported-element-type': return t('memoryViewer.elementTypePending');
  }
}

function aggregateMemberMetadata(member: DebugAggregateSnapshot['members'][number], t: Translate): string {
  if (member.flexibleArray) {
    return t('memoryViewer.flexibleArrayMetadata', {
      length: member.flexibleArray.length,
      elementSize: member.flexibleArray.elementSize,
      capacity: member.flexibleArray.capacityBytes,
      offset: member.offset,
    });
  }
  if (member.bitWidth !== undefined) {
    const positions = member.bitOffset === undefined
      ? ''
      : ` · bits ${member.bitOffset}–${member.bitOffset + member.bitWidth - 1}`;
    return t('memoryViewer.bitFieldMetadata', {
      type: member.type,
      width: member.bitWidth,
      suffix: member.bitWidth === 1 ? '' : 's',
      positions,
      unitSize: member.storageUnitSize ?? member.size,
      offset: member.offset,
    });
  }
  return t('memoryViewer.fieldMetadata', { type: member.type, size: member.size, offset: member.offset });
}

type MemoryViewerAggregateLayoutItem =
  | { readonly kind: 'member'; readonly offset: number; readonly member: DebugAggregateSnapshot['members'][number] }
  | { readonly kind: 'padding'; readonly offset: number; readonly size: number; readonly key: string };

export interface MemoryViewerAggregateBlockProps {
  aggregate: DebugAggregateSnapshot;
  changedMemberKeys: ReadonlySet<string>;
  pointerTargetFieldKey?: string | null;
  pointerTargetRoot?: boolean;
  exiting?: boolean;
  fading?: boolean;
  onPointerHoverChange?: (pointerIdentity: MemoryViewerPointerIdentity, isHovered: boolean) => void;
  onPointerFocusChange?: (pointerIdentity: MemoryViewerPointerIdentity, isFocused: boolean) => void;
}

export function MemoryViewerAggregateBlock({
  aggregate,
  changedMemberKeys,
  pointerTargetFieldKey = null,
  pointerTargetRoot = false,
  exiting = false,
  fading = false,
  onPointerHoverChange,
  onPointerFocusChange,
}: MemoryViewerAggregateBlockProps) {
  const { t } = useI18n();
  const name = aggregate.name ?? (aggregate.region === 'heap'
    ? t('memoryViewer.aggregateOnHeap')
    : t('memoryViewer.temporaryAggregate'));
  const placeholder = aggregateStatusMessage(aggregate, t)
    ?? (aggregate.status === 'available' && hasAnonymousAggregateMember(aggregate) ? t('memoryViewer.anonymousAggregatePending') : null);
  const flexibleArrayMember = aggregate.members.find(member => member.flexibleArray !== undefined);
  const flexibleArray = flexibleArrayMember?.flexibleArray;
  const hasFlexibleArrayValues = flexibleArray !== undefined && flexibleArray.length > 0;
  const aggregateTypeName = aggregate.type.startsWith(`${aggregate.kind} `)
    ? aggregate.type.slice(aggregate.kind.length + 1)
    : aggregate.type.startsWith(`${aggregate.kind}#`)
      ? t('memoryViewer.anonymous')
      : aggregate.type;
  const layoutItems: MemoryViewerAggregateLayoutItem[] = [
    ...aggregate.members.map(member => ({ kind: 'member' as const, offset: member.offset, member })),
    ...aggregate.padding.map(span => ({ kind: 'padding' as const, offset: span.offset, size: span.size, key: span.key })),
  ].sort((left, right) => left.offset - right.offset || (left.kind === 'padding' ? -1 : 1));
  const accessibleLabel = [
    name,
    `${aggregate.kind} ${aggregate.type}`,
    aggregate.duration === 'thread-local' ? t('memoryViewer.durationLabel', { duration: 'thread-local' }) : null,
    t('memoryViewer.address', { address: aggregate.address }),
    t('memoryViewer.sizeBytes', { size: aggregate.size }),
    aggregate.readOnly ? t('memoryViewer.readOnlyLabel') : null,
  ].filter(Boolean).join(', ');

  return (
    <div
      className={`memory-viewer-aggregate${aggregate.readOnly ? ' memory-viewer-aggregate--readonly' : ''}${hasFlexibleArrayValues ? ' memory-viewer-aggregate--has-fam' : ''}${pointerTargetRoot ? ' memory-viewer-aggregate--pointer-target' : ''}${exiting ? ' memory-viewer-aggregate--exiting' : ''}${fading ? ' memory-viewer-aggregate--fading' : ''}`}
      data-memory-viewer-aggregate-id={aggregate.rootId}
      data-memory-viewer-aggregate-view-id={aggregate.viewId ?? aggregate.rootId}
      data-memory-viewer-scalar-id={aggregate.region === 'stack' || aggregate.region === 'heap' ? aggregate.rootId : undefined}
      data-origin={aggregate.origin}
      data-duration={aggregate.duration}
      data-read-only={aggregate.readOnly ? 'true' : undefined}
      data-pointer-target={pointerTargetRoot ? 'true' : undefined}
      role="group"
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      <div className="memory-viewer-aggregate-body">
        {placeholder === null ? (
          aggregate.members.length === 0 ? (
            <div className="memory-viewer-array-placeholder" role="status">{t('memoryViewer.noVisibleMembers')}</div>
          ) : (
            <ol className="memory-viewer-aggregate-members" aria-label={t('memoryViewer.membersOf', { name })}>
              {layoutItems.map(item => item.kind === 'member' ? (
                <li key={item.member.key}>
                  <MemoryViewerScalarCard
                    record={aggregateMemberCardRecord(
                      aggregate,
                      item.member,
                      changedMemberKeys.has(item.member.key),
                      item.member.key === pointerTargetFieldKey,
                      t,
                    )}
                    onPointerHoverChange={onPointerHoverChange}
                    onPointerFocusChange={onPointerFocusChange}
                  />
                  <span
                    className="memory-viewer-scalar-address memory-viewer-aggregate-member-address"
                    title={item.member.address}
                    aria-hidden="true"
                  >
                    <span className="memory-viewer-scalar-address-value">{item.member.address}</span>
                  </span>
                  <span className="memory-viewer-aggregate-member-metadata" title={aggregateMemberMetadata(item.member, t)}>
                    {aggregateMemberMetadata(item.member, t)}
                  </span>
                </li>
              ) : (
                <li
                  className="memory-viewer-aggregate-padding"
                  key={item.key}
                  data-aggregate-kind={aggregate.kind}
                  data-padding-offset={item.offset}
                  data-padding-size={item.size}
                  title={t('memoryViewer.paddingTitle', { type: aggregate.type, offset: item.offset, size: item.size })}
                  aria-label={t('memoryViewer.paddingLabel', { type: aggregate.type, offset: item.offset, size: item.size })}
                />
              ))}
            </ol>
          )
        ) : (
          <div className="memory-viewer-array-placeholder" role="status">{placeholder}</div>
        )}
        {placeholder === null && hasFlexibleArrayValues && flexibleArray && flexibleArrayMember && (
          <div
            className="memory-viewer-aggregate-fam-view"
            data-memory-viewer-fam-member={flexibleArrayMember.name}
            data-memory-viewer-fam-offset={flexibleArrayMember.offset}
            data-memory-viewer-fam-length={flexibleArray.length}
            data-memory-viewer-fam-capacity={flexibleArray.capacityBytes}
            role="group"
            aria-label={t('memoryViewer.elementsOf', { name: flexibleArrayMember.name })}
          >
            {flexibleArrayStatusMessage(flexibleArray.status, t) === null ? (
              <ol className="memory-viewer-array-cells memory-viewer-aggregate-fam-cells" aria-label={t('memoryViewer.elementsOf', { name: flexibleArrayMember.name })}>
                {flexibleArray.elements.map(element => (
                  <li key={element.key}>
                    <MemoryViewerScalarCard
                      record={aggregateFlexibleArrayElementCardRecord(aggregate, flexibleArrayMember, element, t)}
                    />
                    <span
                      className="memory-viewer-scalar-address memory-viewer-array-cell-address"
                      title={element.address}
                      aria-hidden="true"
                    >
                      <span className="memory-viewer-scalar-address-value">{element.address}</span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="memory-viewer-array-placeholder" role="status">
                {flexibleArrayStatusMessage(flexibleArray.status, t)}
              </div>
            )}
            {flexibleArray.omittedElements > 0 && (
              <span className="memory-viewer-aggregate-fam-omitted" role="status">
                {t('memoryViewer.omittedElements', { count: flexibleArray.omittedElements })}
              </span>
            )}
          </div>
        )}
        <span
          className="memory-viewer-aggregate-root-address"
          data-memory-viewer-aggregate-address={aggregate.address}
          aria-label={t('memoryViewer.rootAddress', { address: aggregate.address })}
          title={aggregate.address}
        >
          {aggregate.address}
        </span>
        <MemoryViewerMetadataFooter
          name={name}
          type={aggregateTypeName}
          size={aggregate.size}
          readOnly={aggregate.readOnly}
          objectKind="aggregate"
          wrapperClassName="memory-viewer-aggregate-footer"
        />
      </div>
    </div>
  );
}

function memoryViewerPointerTargetRegion(
  target: MemoryViewerPointerTarget,
  staticScalars: readonly DebugStaticObjectSnapshot[],
  heapObjects: readonly DebugHeapObjectSnapshot[],
  pointers: readonly DebugPointerSnapshot[],
  aggregates: readonly DebugAggregateSnapshot[],
): MemoryRegion {
  if (target.kind === 'array-cell' || target.kind === 'aggregate-root' || target.kind === 'aggregate-field') return target.region;
  if (heapObjects.some(snapshot => snapshot.id === target.allocationId)
    || aggregates.some(snapshot => snapshot.rootId === target.allocationId && snapshot.region === 'heap')) return 'heap';
  return staticScalars.some(snapshot => snapshot.id === target.allocationId)
    || aggregates.some(snapshot => snapshot.rootId === target.allocationId && snapshot.region === 'static')
    || pointers.some(snapshot => snapshot.id === target.allocationId && snapshot.region === 'static')
    ? 'static'
    : 'stack';
}

function expandMemoryViewerPointerTargetRegion(
  current: Record<MemoryRegion, boolean>,
  target: MemoryViewerPointerTarget,
  staticScalars: readonly DebugStaticObjectSnapshot[],
  heapObjects: readonly DebugHeapObjectSnapshot[],
  pointers: readonly DebugPointerSnapshot[],
  aggregates: readonly DebugAggregateSnapshot[],
): Record<MemoryRegion, boolean> {
  const region = memoryViewerPointerTargetRegion(target, staticScalars, heapObjects, pointers, aggregates);
  return current[region] ? current : { ...current, [region]: true };
}

function memoryViewerPointerInteractionTargetKey(
  pointerIdentity: MemoryViewerPointerIdentity,
  target: MemoryViewerPointerTarget,
): string {
  const identity = memoryViewerPointerIdentityKey(pointerIdentity);
  if (target.kind === 'array-cell') return `${identity}:array-cell:${target.allocationId}:${target.elementKey}`;
  if (target.kind === 'aggregate-field') return `${identity}:aggregate-field:${target.allocationId}:${target.fieldKey}`;
  if (target.kind === 'aggregate-root') return `${identity}:aggregate-root:${target.allocationId}`;
  return `${identity}:object:${target.allocationId}`;
}

function hasMemoryViewerPointerIdentity(
  identity: MemoryViewerPointerIdentity,
  pointers: readonly DebugPointerSnapshot[],
  arrays: readonly DebugArraySnapshot[],
  aggregates: readonly DebugAggregateSnapshot[],
): boolean {
  if (identity.kind === 'object-pointer') return pointers.some(pointer => pointer.id === identity.id);
  if (identity.kind === 'array-element-pointer') return arrays.some(array => array.rootId === identity.rootId
    && array.elements.some(element => element.kind === 'pointer'
      && element.index === identity.index
      && element.key === `${identity.rootId}:${identity.index}`));
  return aggregates.some(aggregate => aggregate.rootId === identity.rootId
    && aggregate.members.some(member => member.key === identity.memberKey && member.kind === 'pointer'));
}

function MemoryViewerRegions({
  mode,
  hasUsedHeap,
  hasHeapAllocationCalls,
  lifecycle,
  activeScopes,
  heapObjects,
  arrays,
  omittedArrayObjects,
  aggregates,
  omittedAggregateObjects,
  stackScalars,
  pointers,
  staticObjects,
  stepIndex,
  status,
}: MemoryViewerRegionsProps) {
  const { t } = useI18n();
  const idPrefix = useId();
  const [expanded, setExpanded] = useState<Record<MemoryRegion, boolean>>({
    static: false,
    stack: true,
    heap: false,
  });
  const autoOpenedHeap = useRef(false);
  const expandedPointerTargetKeyRef = useRef<string | null>(null);
  const entrypointMainRootScopeIdRef = useRef<number | null>(null);
  if (entrypointMainRootScopeIdRef.current === null) {
    entrypointMainRootScopeIdRef.current = findEntrypointMainRootScopeId(lifecycle);
  }
  const functionRootScopeIdsByFrame = useMemo(
    () => findMemoryViewerFunctionRootScopeIds(lifecycle),
    [lifecycle],
  );
  const selectedSnapshotRef = useRef({ stepIndex, activeScopes, heapObjects, arrays, aggregates, stackScalars, pointers, staticObjects });
  const heapFocusIdRef = useRef<number | null>(null);
  const [hoveredPointerIdentity, setHoveredPointerIdentity] = useState<MemoryViewerPointerIdentity | null>(null);
  const [focusedPointerIdentity, setFocusedPointerIdentity] = useState<MemoryViewerPointerIdentity | null>(null);
  const staticScalars = useMemo(
    () => filterMemoryViewerStaticScalars(staticObjects, arrays),
    [arrays, staticObjects],
  );
  const pointerTargetScalars = useMemo(
    () => [...stackScalars, ...staticScalars],
    [stackScalars, staticScalars],
  );
  // Keep interaction on the live pointer object while its selected snapshot changes target.
  const activePointerIdentity = hoveredPointerIdentity !== null
    && hasMemoryViewerPointerIdentity(hoveredPointerIdentity, pointers, arrays, aggregates)
    ? hoveredPointerIdentity
    : focusedPointerIdentity !== null && hasMemoryViewerPointerIdentity(focusedPointerIdentity, pointers, arrays, aggregates)
      ? focusedPointerIdentity
      : null;
  const highlightedPointerTarget = useMemo(
    () => resolveMemoryViewerPointerTarget(activePointerIdentity, pointers, pointerTargetScalars, arrays, aggregates),
    [activePointerIdentity, aggregates, arrays, pointerTargetScalars, pointers],
  );
  const highlightedPointerTargetId = highlightedPointerTarget?.kind === 'object'
    ? highlightedPointerTarget.allocationId
    : null;
  const highlightedPointerTargetElementKey = highlightedPointerTarget?.kind === 'array-cell'
    ? highlightedPointerTarget.elementKey
    : null;
  const highlightedAggregateTargetId = highlightedPointerTarget?.kind === 'aggregate-root'
    || highlightedPointerTarget?.kind === 'aggregate-field'
    ? highlightedPointerTarget.allocationId
    : null;
  const highlightedAggregateTargetFieldKey = highlightedPointerTarget?.kind === 'aggregate-field'
    ? highlightedPointerTarget.fieldKey
    : null;
  const highlightedPointerTargetRegion = highlightedPointerTarget === null
    ? null
    : memoryViewerPointerTargetRegion(highlightedPointerTarget, staticScalars, heapObjects, pointers, aggregates);
  const exitTimerRef = useRef<MemoryViewerExitCleanupTimer | null>(null);
  if (!exitTimerRef.current) exitTimerRef.current = new MemoryViewerExitCleanupTimer();
  const heapExitTimerRef = useRef<MemoryViewerExitCleanupTimer | null>(null);
  if (!heapExitTimerRef.current) heapExitTimerRef.current = new MemoryViewerExitCleanupTimer();
  const [exitPresentation, setExitPresentation] = useState(EMPTY_EXIT_PRESENTATION);
  const [heapExitPresentation, setHeapExitPresentation] = useState(EMPTY_HEAP_EXIT_PRESENTATION);
  const [valueChangePresentation, setValueChangePresentation] = useState(EMPTY_VALUE_CHANGE_PRESENTATION);

  function updatePointerHover(pointerIdentity: MemoryViewerPointerIdentity, isHovered: boolean) {
    setHoveredPointerIdentity(current => isHovered
      ? pointerIdentity
      : sameMemoryViewerPointerIdentity(current, pointerIdentity) ? null : current);
  }

  function updatePointerFocus(pointerIdentity: MemoryViewerPointerIdentity, isFocused: boolean) {
    setFocusedPointerIdentity(current => isFocused
      ? pointerIdentity
      : sameMemoryViewerPointerIdentity(current, pointerIdentity) ? null : current);
  }

  useLayoutEffect(() => {
    if (status === 'starting' && stepIndex === 0) {
      expandedPointerTargetKeyRef.current = null;
      setHoveredPointerIdentity(null);
      setFocusedPointerIdentity(null);
      return;
    }
    if (hoveredPointerIdentity !== null && !hasMemoryViewerPointerIdentity(hoveredPointerIdentity, pointers, arrays, aggregates)) {
      setHoveredPointerIdentity(null);
    }
    if (focusedPointerIdentity !== null && !hasMemoryViewerPointerIdentity(focusedPointerIdentity, pointers, arrays, aggregates)) {
      setFocusedPointerIdentity(null);
    }
  }, [aggregates, arrays, focusedPointerIdentity, hoveredPointerIdentity, pointers, status, stepIndex]);

  useLayoutEffect(() => {
    if (status === 'starting' && stepIndex === 0) {
      expandedPointerTargetKeyRef.current = null;
      return;
    }
    if (activePointerIdentity === null || !highlightedPointerTarget) {
      expandedPointerTargetKeyRef.current = null;
      return;
    }
    const targetKey = memoryViewerPointerInteractionTargetKey(activePointerIdentity, highlightedPointerTarget);
    if (expandedPointerTargetKeyRef.current === targetKey) return;
    expandedPointerTargetKeyRef.current = targetKey;
    setExpanded(current => expandMemoryViewerPointerTargetRegion(current, highlightedPointerTarget, staticScalars, heapObjects, pointers, aggregates));
  }, [activePointerIdentity, aggregates, heapObjects, highlightedPointerTarget, pointers, staticScalars, status, stepIndex]);

  const {
    stackSectionRef,
    stackScrollRef,
    ensureVisible,
    cancelPendingFollow: cancelStackFollow,
  } = useStackHorizontalScroll(expanded.stack);
  const {
    stackSectionRef: staticSectionRef,
    stackScrollRef: staticScrollRef,
    ensureVisible: ensureStaticVisible,
  } = useStackHorizontalScroll(expanded.static);
  const {
    stackSectionRef: heapSectionRef,
    stackScrollRef: heapScrollRef,
    ensureVisible: ensureHeapVisible,
    cancelPendingFollow: cancelHeapFollow,
  } = useStackHorizontalScroll(expanded.heap);

  useLayoutEffect(() => {
    if (!highlightedPointerTarget || highlightedPointerTargetRegion === null || !expanded[highlightedPointerTargetRegion]) return;
    const scrollArea = highlightedPointerTargetRegion === 'static'
      ? staticScrollRef.current
      : highlightedPointerTargetRegion === 'heap' ? heapScrollRef.current : stackScrollRef.current;
    const selector = highlightedPointerTarget.kind === 'array-cell'
      ? `[data-memory-viewer-array-element-key="${highlightedPointerTarget.elementKey}"]`
      : highlightedPointerTarget.kind === 'aggregate-field'
        ? `[data-memory-viewer-aggregate-field-key="${highlightedPointerTarget.fieldKey}"]`
        : highlightedPointerTarget.kind === 'aggregate-root'
          ? `[data-memory-viewer-aggregate-id="${highlightedPointerTarget.allocationId}"]`
          : `[data-memory-viewer-scalar-id="${highlightedPointerTarget.allocationId}"]`;
    const target = scrollArea?.querySelector<HTMLElement>(selector);
    if (!target) return;
    if (highlightedPointerTargetRegion === 'static') ensureStaticVisible(target, 12);
    else if (highlightedPointerTargetRegion === 'heap') ensureHeapVisible(target, 12);
    else ensureVisible(target, 12);
  }, [ensureHeapVisible, ensureStaticVisible, ensureVisible, expanded.heap, expanded.stack, expanded.static, highlightedPointerTarget, highlightedPointerTargetRegion, heapScrollRef, stackScrollRef, staticScrollRef]);

  function clearExitTimer() {
    exitTimerRef.current?.clear();
  }

  function clearHeapExitTimer() {
    heapExitTimerRef.current?.clear();
  }

  function finishExitTransition(transitionStep: number, fullyVisible: boolean) {
    exitTimerRef.current?.clear();

    if (!fullyVisible) {
      setExitPresentation(current => current.stepIndex === transitionStep && current.phase === 'waiting'
        ? EMPTY_EXIT_PRESENTATION
        : current);
      return;
    }

    setExitPresentation(current => current.stepIndex === transitionStep && current.phase === 'waiting'
      ? { ...current, phase: 'fading' }
      : current);

    const scrollArea = stackScrollRef.current;
    if (!scrollArea) return;
    const duration = readMemoryViewerExitDuration(window.getComputedStyle(scrollArea));
    exitTimerRef.current?.schedule(() => {
      setExitPresentation(current => current.stepIndex === transitionStep && current.phase === 'fading'
        ? EMPTY_EXIT_PRESENTATION
        : current);
    }, duration);
  }

  function finishHeapExitTransition(transitionStep: number, fullyVisible: boolean) {
    heapExitTimerRef.current?.clear();

    if (!fullyVisible) {
      setHeapExitPresentation(current => current.stepIndex === transitionStep && current.phase === 'waiting'
        ? EMPTY_HEAP_EXIT_PRESENTATION
        : current);
      return;
    }

    setHeapExitPresentation(current => current.stepIndex === transitionStep && current.phase === 'waiting'
      ? { ...current, phase: 'fading' }
      : current);

    const scrollArea = heapScrollRef.current;
    if (!scrollArea) return;
    const duration = readMemoryViewerExitDuration(window.getComputedStyle(scrollArea));
    heapExitTimerRef.current?.schedule(() => {
      setHeapExitPresentation(current => current.stepIndex === transitionStep && current.phase === 'fading'
        ? EMPTY_HEAP_EXIT_PRESENTATION
        : current);
    }, duration);
  }

  useLayoutEffect(() => {
    const previous = selectedSnapshotRef.current;
    const current = { stepIndex, activeScopes, heapObjects, arrays, aggregates, stackScalars, pointers, staticObjects };
    selectedSnapshotRef.current = current;

    if (status === 'starting' && stepIndex === 0) {
      cancelStackFollow();
      cancelHeapFollow();
      heapFocusIdRef.current = null;
      clearExitTimer();
      clearHeapExitTimer();
      setExitPresentation(EMPTY_EXIT_PRESENTATION);
      setHeapExitPresentation(EMPTY_HEAP_EXIT_PRESENTATION);
      setValueChangePresentation(EMPTY_VALUE_CHANGE_PRESENTATION);
      expandedPointerTargetKeyRef.current = null;
      setHoveredPointerIdentity(null);
      setFocusedPointerIdentity(null);
      return;
    }
    if (previous.stepIndex === stepIndex) return;

    clearExitTimer();
    clearHeapExitTimer();
    const changedStackScalarIds = findMemoryViewerChangedScalarIds(previous.stackScalars, stackScalars);
    const previousStackPointers = previous.pointers.filter(pointer => pointer.region === 'stack');
    const currentStackPointers = pointers.filter(pointer => pointer.region === 'stack');
    const changedStackPointerIds = findMemoryViewerChangedPointerIds(previousStackPointers, currentStackPointers);
    const changedStaticObjectIds = findMemoryViewerChangedScalarIds(previous.staticObjects, staticObjects);
    const previousStaticPointers = previous.pointers.filter(pointer => pointer.region === 'static');
    const currentStaticPointers = pointers.filter(pointer => pointer.region === 'static');
    const changedStaticPointerIds = findMemoryViewerChangedPointerIds(previousStaticPointers, currentStaticPointers);
    const changedArrayElementKeys = findMemoryViewerChangedArrayElementKeys(previous.arrays, arrays);
    const changedAggregateMemberKeys = findMemoryViewerChangedAggregateMemberKeys(previous.aggregates, aggregates);
    setValueChangePresentation(
      changedStackScalarIds.length > 0 || changedStackPointerIds.length > 0
        || changedStaticObjectIds.length > 0 || changedStaticPointerIds.length > 0
        || changedArrayElementKeys.length > 0 || changedAggregateMemberKeys.length > 0
        ? {
          stepIndex,
          stackScalarIds: changedStackScalarIds,
          stackPointerIds: changedStackPointerIds,
          staticObjectIds: changedStaticObjectIds,
          staticPointerIds: changedStaticPointerIds,
          arrayElementKeys: changedArrayElementKeys,
          aggregateMemberKeys: changedAggregateMemberKeys,
        }
        : EMPTY_VALUE_CHANGE_PRESENTATION,
    );
    const heapTransition = compareMemoryViewerHeapObjects(previous.heapObjects, heapObjects);
    const heapFocusId = chooseMemoryViewerHeapFocusId(heapTransition);
    const previousStackArrays = previous.arrays.filter(array => array.region === 'stack');
    const currentStackArrays = arrays.filter(array => array.region === 'stack');
    const previousStackAggregates = previous.aggregates.filter(aggregate => aggregate.region === 'stack');
    const currentStackAggregates = aggregates.filter(aggregate => aggregate.region === 'stack');
    const transition = compareMemoryViewerStackSnapshots(
      previous.stackScalars,
      stackScalars,
      previous.activeScopes,
      activeScopes,
      previousStackArrays,
      currentStackArrays,
      previousStackPointers,
      currentStackPointers,
      previousStackAggregates,
      currentStackAggregates,
    );

    if (stepIndex < previous.stepIndex) {
      cancelStackFollow();
      cancelHeapFollow();
      heapFocusIdRef.current = chooseMemoryViewerHeapFocusId({
        created: heapTransition.created,
        deleted: [],
      });
      setHeapExitPresentation(EMPTY_HEAP_EXIT_PRESENTATION);
      setExitPresentation({
        stepIndex,
        deletedScalars: [],
        deletedPointers: [],
        deletedArrays: [],
        deletedAggregates: [],
        exitedScopes: [],
        previousStackObjectIds: [],
        previousScopeIds: [],
        focusId: chooseMemoryViewerStackFocusId(
          { ...transition, deletedScalars: [], deletedPointers: [], deletedArrays: [], deletedAggregates: [] },
          previous.stackScalars,
          stackScalars,
          previousStackArrays,
          currentStackArrays,
          previousStackPointers,
          currentStackPointers,
          previousStackAggregates,
          currentStackAggregates,
        ),
        phase: 'waiting',
      });
      return;
    }

    heapFocusIdRef.current = heapTransition.deleted.length > 0 ? null : heapFocusId;
    setHeapExitPresentation(heapTransition.deleted.length > 0
      ? {
        stepIndex,
        deletedObjects: heapTransition.deleted,
        previousObjectIds: previous.heapObjects.map(object => object.id),
        focusId: heapFocusId,
        phase: 'waiting',
      }
      : EMPTY_HEAP_EXIT_PRESENTATION);
    const exitingScopeIds = new Set([
      ...transition.deletedScalars.map(scalar => scalar.scopeId),
      ...transition.deletedPointers.flatMap(pointer => pointer.scopeId === null ? [] : [pointer.scopeId]),
      ...transition.deletedArrays.flatMap(array => array.scopeId === null ? [] : [array.scopeId]),
      ...transition.deletedAggregates.flatMap(aggregate => aggregate.scopeId === null ? [] : [aggregate.scopeId]),
    ]);
    const exitedScopes = transition.exitedScopes.filter(scope => exitingScopeIds.has(scope.id));
    setExitPresentation({
      stepIndex,
      deletedScalars: transition.deletedScalars,
      deletedPointers: transition.deletedPointers,
      deletedArrays: transition.deletedArrays,
      deletedAggregates: transition.deletedAggregates,
      exitedScopes,
      previousStackObjectIds: transition.deletedScalars.length > 0 || transition.deletedPointers.length > 0 || transition.deletedArrays.length > 0 || transition.deletedAggregates.length > 0
        ? stackMemoryObjects(previous.stackScalars, previousStackArrays, previousStackPointers, previousStackAggregates).map(object => object.id)
        : [],
      previousScopeIds: transition.deletedScalars.length > 0 || transition.deletedPointers.length > 0 || transition.deletedArrays.length > 0 || transition.deletedAggregates.length > 0
        ? previous.activeScopes.map(scope => scope.id)
        : [],
      focusId: chooseMemoryViewerStackFocusId(
        transition,
        previous.stackScalars,
        stackScalars,
        previousStackArrays,
        currentStackArrays,
        previousStackPointers,
        currentStackPointers,
        previousStackAggregates,
        currentStackAggregates,
      ),
      phase: 'waiting',
    });
  }, [activeScopes, aggregates, arrays, cancelHeapFollow, cancelStackFollow, heapObjects, pointers, stackScalars, staticObjects, status, stepIndex]);

  useLayoutEffect(() => {
    if (!expanded.heap) return;
    const hasCurrentHeapExit = heapExitPresentation.stepIndex === stepIndex
      && heapExitPresentation.deletedObjects.length > 0
      && heapExitPresentation.phase === 'waiting';
    const focusId = hasCurrentHeapExit ? heapExitPresentation.focusId : heapFocusIdRef.current;
    if (focusId === null) return;

    const target = heapScrollRef.current?.querySelector<HTMLElement>(
      `[data-memory-viewer-scalar-id="${focusId}"]`,
    );
    if (!target) {
      if (hasCurrentHeapExit) finishHeapExitTransition(stepIndex, false);
      else heapFocusIdRef.current = null;
      return;
    }

    if (!hasCurrentHeapExit) {
      heapFocusIdRef.current = null;
      ensureHeapVisible(target, 12);
      return;
    }

    ensureHeapVisible(
      target,
      12,
      fullyVisible => finishHeapExitTransition(stepIndex, fullyVisible),
    );
  }, [ensureHeapVisible, expanded.heap, heapExitPresentation, heapObjects, heapScrollRef, stepIndex]);

  useLayoutEffect(() => {
    if (exitPresentation.stepIndex !== stepIndex || exitPresentation.phase !== 'waiting') return;
    const { focusId, deletedScalars, deletedPointers, deletedArrays, deletedAggregates } = exitPresentation;
    if (focusId === null) return;

    const scrollArea = stackScrollRef.current;
    const target = scrollArea?.querySelector<HTMLElement>(
      `[data-memory-viewer-scalar-id="${focusId}"]`,
    );
    if (!target) {
      if (deletedScalars.length > 0 || deletedPointers.length > 0 || deletedArrays.length > 0 || deletedAggregates.length > 0) finishExitTransition(exitPresentation.stepIndex, false);
      return;
    }

    ensureVisible(
      target,
      12,
      deletedScalars.length > 0 || deletedPointers.length > 0 || deletedArrays.length > 0 || deletedAggregates.length > 0
        ? fullyVisible => finishExitTransition(exitPresentation.stepIndex, fullyVisible)
        : undefined,
    );
  }, [ensureVisible, exitPresentation, stackScrollRef, stepIndex]);

  function renderStackContents() {
    const isCurrentPresentation = exitPresentation.stepIndex === stepIndex;
    const changedScalarIds = new Set(valueChangePresentation.stepIndex === stepIndex
      ? valueChangePresentation.stackScalarIds
      : []);
    const changedPointerIds = new Set(valueChangePresentation.stepIndex === stepIndex
      ? valueChangePresentation.stackPointerIds
      : []);
    const changedArrayElementKeys = new Set(valueChangePresentation.stepIndex === stepIndex
      ? valueChangePresentation.arrayElementKeys
      : []);
    const changedAggregateMemberKeys = new Set(valueChangePresentation.stepIndex === stepIndex
      ? valueChangePresentation.aggregateMemberKeys
      : []);
    const deletedScalarIds = new Set(isCurrentPresentation
      ? exitPresentation.deletedScalars.map(scalar => scalar.id)
      : []);
    const deletedPointerIds = new Set(isCurrentPresentation
      ? exitPresentation.deletedPointers.map(pointer => pointer.id)
      : []);
    const deletedArrayIds = new Set(isCurrentPresentation
      ? exitPresentation.deletedArrays.map(array => array.rootId)
      : []);
    const deletedAggregateIds = new Set(isCurrentPresentation
      ? exitPresentation.deletedAggregates.map(aggregate => aggregate.viewId ?? aggregate.rootId)
      : []);
    const stackArrays = arrays.filter(array => array.region === 'stack');
    const stackAggregates = aggregates.filter(aggregate => aggregate.region === 'stack');
    const activeScopeIds = new Set(activeScopes.map(scope => scope.id));
    const currentScopeId = activeScopes.at(-1)?.id;
    const ghostScopes = isCurrentPresentation
      ? exitPresentation.exitedScopes.filter(scope => (deletedScalarIds.size > 0 || deletedPointerIds.size > 0 || deletedArrayIds.size > 0 || deletedAggregateIds.size > 0) && !activeScopeIds.has(scope.id))
      : [];
    const displayedScopes = mergeExitedItemsInPreviousOrder(
      isCurrentPresentation ? exitPresentation.previousScopeIds : [],
      activeScopes,
      ghostScopes,
    );
    const displayedObjects = mergeExitedItemsInPreviousOrder(
      isCurrentPresentation ? exitPresentation.previousStackObjectIds : [],
      stackMemoryObjects(stackScalars, stackArrays, pointers, stackAggregates),
      isCurrentPresentation ? [
        ...exitPresentation.deletedScalars.map(snapshot => ({ id: snapshot.id, kind: 'scalar' as const, snapshot })),
        ...exitPresentation.deletedPointers.map(snapshot => ({ id: snapshot.id, kind: 'pointer' as const, snapshot })),
        ...exitPresentation.deletedArrays.map(snapshot => ({ id: snapshot.rootId, kind: 'array' as const, snapshot })),
        ...exitPresentation.deletedAggregates.map(snapshot => ({ id: snapshot.viewId ?? snapshot.rootId, kind: 'aggregate' as const, snapshot })),
      ] : [],
    );
    const objectsByScope = new Map<number, MemoryViewerStackObject[]>();
    for (const object of displayedObjects) {
      const scopeId = object.snapshot.scopeId;
      if (scopeId === null) continue;
      const objects = objectsByScope.get(scopeId);
      if (objects) objects.push(object);
      else objectsByScope.set(scopeId, [object]);
    }
    const visibleScopes = displayedScopes.filter(scope => scope.id !== entrypointMainRootScopeIdRef.current
      || (objectsByScope.get(scope.id)?.length ?? 0) > 0);

    return (
      <div className={`memory-viewer-scope-track${visibleScopes.length === 0 ? ' memory-viewer-scope-track--empty' : ''}`} style={scopeNameFrameStyle}>
        {visibleScopes.length === 0 ? <span className="memory-viewer-region-empty">{t('memoryViewer.scopesEmpty')}</span> : (
          <ol className="memory-viewer-scope-list" aria-label={t('memoryViewer.stackScopes')}>
            {visibleScopes.map(scope => {
              const isExitingScope = isCurrentPresentation && !activeScopeIds.has(scope.id);
              const isFadingScope = isExitingScope && exitPresentation.phase === 'fading';
              const isAncestorScope = !isExitingScope
                && activeScopeIds.has(scope.id)
                && scope.id !== currentScopeId;
              const isEntrypointMainRoot = scope.id === entrypointMainRootScopeIdRef.current;
              const functionRootScopeId = scope.frameId === null
                ? undefined
                : functionRootScopeIdsByFrame.get(scope.frameId);
              const isFunctionRoot = functionRootScopeId === undefined
                ? scope.scopeName === scope.functionName
                : functionRootScopeId === scope.id;
              const isForBodyScope = isForBodyMemoryViewerScope(scope.scopeName);
              const isAnonymousScope = scope.scopeName === 'block' && !isFunctionRoot;
              const accessibleScopeName = isAnonymousScope ? 'scope' : scope.scopeName;
              const visibleScopeName = isForBodyScope
                ? null
                : isAnonymousScope
                  ? mode === 'minimal' ? null : 'scope'
                  : truncateMemoryViewerScopeName(scope.scopeName);
              const objects = objectsByScope.get(scope.id) ?? [];
              return (
                <li
                  className={`memory-viewer-scope${isForBodyScope ? ' memory-viewer-scope--for-body' : ''}${isAncestorScope ? ' memory-viewer-scope--ancestor' : ''}${isExitingScope ? ' memory-viewer-scope--exiting' : ''}${isFadingScope ? ' memory-viewer-scope--fading' : ''}`}
                  key={scope.id}
                  aria-label={isEntrypointMainRoot
                    ? t('memoryViewer.mainRootDescription')
                    : t(isExitingScope ? 'memoryViewer.exitedScope' : 'memoryViewer.activeScope', { scope: accessibleScopeName })}
                >
                  {!isEntrypointMainRoot && (
                    <>
                      {visibleScopeName !== null && (
                        <span className="memory-viewer-scope-name" title={accessibleScopeName}>{visibleScopeName}</span>
                      )}
                      <span className="memory-viewer-scope-bar" aria-hidden="true" />
                    </>
                  )}
                {objects.map(object => {
                    if (object.kind === 'scalar') {
                      const isExitingScalar = deletedScalarIds.has(object.id);
                      return (
                        <MemoryViewerScalarCard
                          key={`scalar-${object.id}`}
                          record={{
                            ...scalarCardRecord(object.snapshot, t, changedScalarIds.has(object.id)),
                            isPointerTarget: object.id === highlightedPointerTargetId,
                          }}
                          exiting={isExitingScalar}
                          fading={isExitingScalar && exitPresentation.phase === 'fading'}
                        />
                      );
                    }
                  if (object.kind === 'pointer') {
                    const isExitingPointer = deletedPointerIds.has(object.id);
                    return (
                      <MemoryViewerScalarCard
                        key={`pointer-${object.id}`}
                        record={pointerCardRecord(
                          object.snapshot,
                          changedPointerIds.has(object.id),
                          object.id === highlightedPointerTargetId,
                          t,
                        )}
                        exiting={isExitingPointer}
                        fading={isExitingPointer && exitPresentation.phase === 'fading'}
                        onPointerHoverChange={updatePointerHover}
                        onPointerFocusChange={updatePointerFocus}
                      />
                    );
                  }
                  if (object.kind === 'aggregate') {
                    const isExitingAggregate = deletedAggregateIds.has(object.id);
                    return (
                      <MemoryViewerAggregateBlock
                        key={`aggregate-${object.id}`}
                        aggregate={object.snapshot}
                        changedMemberKeys={changedAggregateMemberKeys}
                        pointerTargetFieldKey={object.id === highlightedAggregateTargetId ? highlightedAggregateTargetFieldKey : null}
                        pointerTargetRoot={highlightedPointerTarget?.kind === 'aggregate-root'
                          && object.id === highlightedAggregateTargetId}
                        exiting={isExitingAggregate}
                        fading={isExitingAggregate && exitPresentation.phase === 'fading'}
                        onPointerHoverChange={updatePointerHover}
                        onPointerFocusChange={updatePointerFocus}
                      />
                    );
                  }
                    const isExitingArray = deletedArrayIds.has(object.id);
                    return (
                      <MemoryViewerArrayBlock
                        key={`array-${object.id}`}
                        array={object.snapshot}
                        changedElementKeys={changedArrayElementKeys}
                        pointerTargetElementKey={highlightedPointerTargetElementKey}
                        exiting={isExitingArray}
                        fading={isExitingArray && exitPresentation.phase === 'fading'}
                        onPointerHoverChange={updatePointerHover}
                        onPointerFocusChange={updatePointerFocus}
                      />
                    );
                  })}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    );
  }

  function renderStaticContents() {
    const changedObjectIds = new Set(valueChangePresentation.stepIndex === stepIndex
      ? valueChangePresentation.staticObjectIds
      : []);
    const changedPointerIds = new Set(valueChangePresentation.stepIndex === stepIndex
      ? valueChangePresentation.staticPointerIds
      : []);
    const changedArrayElementKeys = new Set(valueChangePresentation.stepIndex === stepIndex
      ? valueChangePresentation.arrayElementKeys
      : []);
    const changedAggregateMemberKeys = new Set(valueChangePresentation.stepIndex === stepIndex
      ? valueChangePresentation.aggregateMemberKeys
      : []);
    const staticArrays = arrays.filter(array => array.region === 'static');
    const staticAggregates = aggregates.filter(aggregate => aggregate.region === 'static');
    const staticItems = staticMemoryObjects(staticScalars, staticArrays, pointers, staticAggregates);
    return staticItems.length === 0 ? (
      <span className="memory-viewer-region-empty">{t('memoryViewer.empty')}</span>
    ) : (
      <ol className="memory-viewer-static-list" aria-label={t('memoryViewer.staticObjects')}>
        {staticItems.map(item => (
          <li key={`${item.kind}-${item.id}`}>
            {item.kind === 'scalar' ? (
              <MemoryViewerScalarCard
                record={{ ...scalarCardRecord(item.snapshot, t, changedObjectIds.has(item.id)), isPointerTarget: item.id === highlightedPointerTargetId }}
              />
            ) : item.kind === 'pointer' ? (
              <MemoryViewerScalarCard
                record={pointerCardRecord(item.snapshot, changedPointerIds.has(item.id), item.id === highlightedPointerTargetId, t)}
                onPointerHoverChange={updatePointerHover}
                onPointerFocusChange={updatePointerFocus}
              />
            ) : item.kind === 'array' ? (
              <MemoryViewerArrayBlock
                array={item.snapshot}
                changedElementKeys={changedArrayElementKeys}
                pointerTargetElementKey={highlightedPointerTargetElementKey}
                onPointerHoverChange={updatePointerHover}
                onPointerFocusChange={updatePointerFocus}
              />
            ) : (
              <MemoryViewerAggregateBlock
                aggregate={item.snapshot}
                changedMemberKeys={changedAggregateMemberKeys}
                pointerTargetFieldKey={item.id === highlightedAggregateTargetId ? highlightedAggregateTargetFieldKey : null}
                pointerTargetRoot={highlightedPointerTarget?.kind === 'aggregate-root'
                  && item.id === highlightedAggregateTargetId}
                onPointerHoverChange={updatePointerHover}
                onPointerFocusChange={updatePointerFocus}
              />
            )}
          </li>
        ))}
      </ol>
    );
  }

  function renderHeapContents() {
    const isCurrentPresentation = heapExitPresentation.stepIndex === stepIndex;
    const deletedObjectIds = new Set(isCurrentPresentation
      ? heapExitPresentation.deletedObjects.map(object => object.id)
      : []);
    const displayedObjects = mergeMemoryViewerHeapObjects(
      isCurrentPresentation ? heapExitPresentation.previousObjectIds : [],
      heapObjects,
      isCurrentPresentation ? heapExitPresentation.deletedObjects : [],
    );
    const visibleItems = mergeMemoryViewerHeapViews(
      displayedObjects,
      aggregates.filter(aggregate => aggregate.region === 'heap'),
      heapObjects,
    );
    const changedAggregateMemberKeys = new Set(valueChangePresentation.stepIndex === stepIndex
      ? valueChangePresentation.aggregateMemberKeys
      : []);

    return visibleItems.length === 0 ? (
      <span className="memory-viewer-region-empty">{t('memoryViewer.empty')}</span>
    ) : (
      <ol className="memory-viewer-heap-list" aria-label={t('memoryViewer.heapBlocks')}>
        {visibleItems.map(item => {
          const isExitingBlock = item.kind === 'block' && deletedObjectIds.has(item.id);
          return (
            <li key={`${item.kind}-${item.id}`}>
              {item.kind === 'block' ? (
                <MemoryViewerScalarCard
                  record={heapCardRecord(item.snapshot, t)}
                  exiting={isExitingBlock}
                  fading={isExitingBlock && heapExitPresentation.phase === 'fading'}
                />
              ) : (
                <MemoryViewerAggregateBlock
                  aggregate={item.snapshot}
                  changedMemberKeys={changedAggregateMemberKeys}
                  pointerTargetFieldKey={item.id === highlightedAggregateTargetId ? highlightedAggregateTargetFieldKey : null}
                  pointerTargetRoot={highlightedPointerTarget?.kind === 'aggregate-root' && item.id === highlightedAggregateTargetId}
                  onPointerHoverChange={updatePointerHover}
                  onPointerFocusChange={updatePointerFocus}
                />
              )}
            </li>
          );
        })}
      </ol>
    );
  }

  useLayoutEffect(() => {
    if (!(hasHeapAllocationCalls || hasUsedHeap) || autoOpenedHeap.current) return;
    autoOpenedHeap.current = true;
    setExpanded(current => ({ ...current, heap: true }));
  }, [hasHeapAllocationCalls, hasUsedHeap]);

  useEffect(() => {
    if (expanded.stack) return;
    clearExitTimer();
    setExitPresentation(EMPTY_EXIT_PRESENTATION);
  }, [expanded.stack]);

  useEffect(() => {
    if (expanded.heap) return;
    clearHeapExitTimer();
    setHeapExitPresentation(EMPTY_HEAP_EXIT_PRESENTATION);
  }, [expanded.heap]);

  useEffect(() => () => {
    clearExitTimer();
    clearHeapExitTimer();
  }, []);

  function renderRegion(region: MemoryRegion, label: string) {
    const isExpanded = expanded[region];
    const headingId = `${idPrefix}-${region}-heading`;
    const contentId = `${idPrefix}-${region}-content`;
    const staticIsEmpty = staticScalars.length === 0
      && !arrays.some(array => array.region === 'static')
      && !aggregates.some(aggregate => aggregate.region === 'static')
      && !pointers.some(pointer => pointer.region === 'static');

    return (
      <section
        className="memory-viewer-region"
        key={region}
        ref={region === 'stack' ? stackSectionRef : region === 'static' ? staticSectionRef : heapSectionRef}
      >
        <h3 className="memory-viewer-region-heading">
          <button
            id={headingId}
            className="memory-viewer-region-toggle"
            type="button"
            aria-expanded={isExpanded}
            aria-controls={contentId}
            onClick={() => setExpanded(current => ({ ...current, [region]: !current[region] }))}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="m4.5 6 3.5 3.5L11.5 6" />
            </svg>
            <span>{label}</span>
          </button>
        </h3>
        <div
          id={contentId}
          className={`memory-viewer-region-content${region === 'stack' ? ' memory-viewer-region-content--stack' : ''}${region === 'static' ? ` memory-viewer-region-content--static${staticIsEmpty ? ' memory-viewer-region-content--empty' : ''}` : ''}${region === 'heap' ? ` memory-viewer-region-content--heap${heapObjects.length === 0 && !aggregates.some(aggregate => aggregate.region === 'heap') ? ' memory-viewer-region-content--empty' : ''}` : ''}`}
          ref={region === 'stack' ? stackScrollRef : region === 'static' ? staticScrollRef : heapScrollRef}
          role="region"
          aria-labelledby={headingId}
          hidden={!isExpanded}
        >
          {region === 'stack'
            ? renderStackContents()
            : region === 'static'
              ? renderStaticContents()
              : renderHeapContents()}
        </div>
      </section>
    );
  }

  return (
    <section className="memory-viewer-regions" aria-label={t('memoryViewer.regionLabel')}>
      {omittedArrayObjects > 0 && (
        <div className="memory-viewer-array-omitted" role="status">
          {t(omittedArrayObjects === 1 ? 'memoryViewer.arraysOmitted.one' : 'memoryViewer.arraysOmitted.other', { count: omittedArrayObjects })}
        </div>
      )}
      {omittedAggregateObjects > 0 && (
        <div className="memory-viewer-array-omitted" role="status">
          {t(omittedAggregateObjects === 1 ? 'memoryViewer.structsOmitted.one' : 'memoryViewer.structsOmitted.other', { count: omittedAggregateObjects })}
        </div>
      )}
      {renderRegion('static', 'Static / TLS')}
      {renderRegion('stack', 'Stack')}
      {renderRegion('heap', 'Heap')}
    </section>
  );
}

export function MemoryViewer({ source, configuration, onClose }: MemoryViewerProps) {
  const { language, t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const backdropPointerIdRef = useRef<number | null>(null);
  const [mode, setMode] = useState<MemoryViewerMode>('minimal');
  const {
    source: frozenSource,
    location,
    status,
    isPlaying,
    stepIndex,
    hasUsedHeap,
    hasHeapAllocationCalls,
    lifecycle,
    activeScopes,
    heapObjects,
    pointers,
    arrays,
    omittedArrayObjects,
    aggregates,
    omittedAggregateObjects,
    stackScalars,
    staticObjects,
    canPrevious,
    canNext,
    canStop,
    transcript,
    inputRequestId,
    isViewingHistory,
    errorMessage,
    historyNotice,
    togglePlay,
    previous,
    next,
    sendStdinLine,
    sendStdinEOF,
    setConsoleEnabled,
    stop,
    transcriptRevision,
  } = useMemoryViewer(source, configuration, false);
  const hasStdioInclude = useMemo(() => hasDirectStdioInclude(frozenSource), [frozenSource]);
  const [ioPreference, setIoPreference] = useState(false);
  const showIoConsole = hasStdioInclude && ioPreference;
  useEffect(() => {
    setConsoleEnabled(showIoConsole);
  }, [setConsoleEnabled, showIoConsole]);
  const hasMainSourceLocation = location?.file === 'main.c';
  const consoleTranscript = useMemo<readonly ConsoleEntry[]>(
    () => transcript.map(entry => entry.stream === 'system'
      ? { stream: 'system', text: entry.text, tone: entry.tone, role: entry.role }
      : { stream: entry.stream, text: entry.text }),
    [transcript, transcriptRevision],
  );
  const consoleSegments = useMemo(
    () => formatConsoleSegments({ status: 'running', transcript: consoleTranscript, inputRequestId }),
    [consoleTranscript, inputRequestId],
  );
  const consoleStatus = getDebugConsoleStatus(status, isPlaying, isViewingHistory, inputRequestId, t);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  function closeFromEscape(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    onClose();
  }

  function rememberBackdropPointer(event: ReactPointerEvent<HTMLDialogElement>) {
    backdropPointerIdRef.current = null;
    if (!event.isPrimary || event.button !== 0 || event.target !== event.currentTarget) return;
    if (isOutsideDialogBounds(event.currentTarget, event.clientX, event.clientY)) {
      backdropPointerIdRef.current = event.pointerId;
    }
  }

  function validateBackdropPointerEnd(event: ReactPointerEvent<HTMLDialogElement>) {
    if (backdropPointerIdRef.current !== event.pointerId) return;
    if (!event.isPrimary
      || event.button !== 0
      || event.target !== event.currentTarget
      || !isOutsideDialogBounds(event.currentTarget, event.clientX, event.clientY)) {
      backdropPointerIdRef.current = null;
    }
  }

  function clearCancelledBackdropPointer(event: ReactPointerEvent<HTMLDialogElement>) {
    if (backdropPointerIdRef.current === event.pointerId) backdropPointerIdRef.current = null;
  }

  function closeFromBackdrop(event: ReactMouseEvent<HTMLDialogElement>) {
    const startedOutside = backdropPointerIdRef.current !== null;
    backdropPointerIdRef.current = null;
    if (!startedOutside
      || event.target !== event.currentTarget
      || !isOutsideDialogBounds(event.currentTarget, event.clientX, event.clientY)) return;
    onClose();
  }

  const locationLabel = location
    ? hasMainSourceLocation
      ? `main.c:${location.line}:${location.column}`
      : t('memoryViewer.location', { file: location.file, line: location.line, column: location.column })
    : '';

  return (
    <dialog
      ref={dialogRef}
      className="memory-viewer-dialog"
      aria-labelledby="memory-viewer-title"
      onCancel={closeFromEscape}
      onPointerDown={rememberBackdropPointer}
      onPointerUp={validateBackdropPointerEnd}
      onPointerCancel={clearCancelledBackdropPointer}
      onClick={closeFromBackdrop}
    >
      <div className="memory-viewer-window" data-memory-viewer-mode={mode}>
        <header className="memory-viewer-header">
          <div className="memory-viewer-controls" aria-label={t('memoryViewer.controls')}>
            <Button
              className="memory-viewer-control memory-viewer-icon-control"
              variant="ghost"
              size="sm"
              type="button"
              aria-label={t(isPlaying ? 'memoryViewer.pause' : 'memoryViewer.play')}
              title={t(isPlaying ? 'memoryViewer.pause' : 'memoryViewer.play')}
              disabled={status === 'starting' || status === 'waiting-input' || status === 'terminated' || status === 'cancelled' || status === 'error' || status === 'limit'}
              onClick={togglePlay}
            >
              {isPlaying ? (
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M5 3.5v9M11 3.5v9" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M4 2.5 13 8l-9 5.5Z" />
                </svg>
              )}
            </Button>
            <Button
              className="memory-viewer-control memory-viewer-icon-control"
              variant="ghost"
              size="sm"
              type="button"
              aria-label={t('memoryViewer.previous')}
              title={t('memoryViewer.previous')}
              disabled={!canPrevious}
              onClick={previous}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4 3v10M12.5 3.5 6 8l6.5 4.5Z" />
              </svg>
            </Button>
            <Button
              className="memory-viewer-control memory-viewer-icon-control"
              variant="ghost"
              size="sm"
              type="button"
              aria-label={t('memoryViewer.next')}
              title={t('memoryViewer.next')}
              disabled={!canNext}
              onClick={next}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M12 3v10M3.5 3.5 10 8l-6.5 4.5Z" />
              </svg>
            </Button>
          </div>
          <h2 id="memory-viewer-title">{t('memoryViewer.title')}</h2>
          <div className="memory-viewer-header-actions">
            <label className="memory-viewer-io-toggle" data-disabled={!hasStdioInclude || undefined} title={t(hasStdioInclude ? 'memoryViewer.ioToggle' : 'memoryViewer.ioUnavailable')}>
              <input
                type="checkbox"
                checked={showIoConsole}
                disabled={!hasStdioInclude}
                onChange={event => setIoPreference(event.currentTarget.checked)}
              />
              <span>{t('memoryViewer.io')}</span>
            </label>
            <select
              className="memory-viewer-mode-select"
              aria-label={t('memoryViewer.mode')}
              title={t('memoryViewer.mode')}
              value={mode}
              onChange={event => setMode(event.currentTarget.value as MemoryViewerMode)}
            >
              {MEMORY_VIEWER_MODES.map(option => (
                <option key={option.value} value={option.value}>
                  {t(option.value === 'minimal' ? 'memoryViewer.mode.minimal' : option.value === 'normal' ? 'memoryViewer.mode.normal' : 'memoryViewer.mode.debug')}
                </option>
              ))}
            </select>
            {canStop && !showIoConsole && (
              <Button
                className="memory-viewer-control"
                variant="ghost"
                size="sm"
                type="button"
                aria-label={t('memoryViewer.stopDebugging')}
                title={t('memoryViewer.stopDebugging')}
                onClick={stop}
              >
                {t('run.stop')}
              </Button>
            )}
            <Button
              ref={closeButtonRef}
              className="memory-viewer-control memory-viewer-icon-control"
              variant="ghost"
              size="sm"
              type="button"
              aria-label={t('memoryViewer.close')}
              onClick={onClose}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </Button>
          </div>
        </header>
        <div className="memory-viewer-filebar">
          <SelectedFileTab fileName="main.c" />
          <span className="memory-viewer-status" role="status" aria-live="polite" aria-atomic="true">
            {isViewingHistory ? t('memoryViewer.status.historySelected') : getStatusLabel(status, isPlaying, t)}
          </span>
          {locationLabel && <span className="memory-viewer-location">{locationLabel}</span>}
        </div>
        {historyNotice && (
          <p className="memory-viewer-history-notice" role="status" aria-live="polite">
            {t(historyNotice === 1 ? 'memoryViewer.historyNotice.one' : 'memoryViewer.historyNotice.other', {
              count: new Intl.NumberFormat(language).format(historyNotice),
            })}
          </p>
        )}
        {errorMessage && (
          <p className="memory-viewer-error" role="alert">{errorMessage}</p>
        )}
        <main className="editor-pane memory-viewer-editor-pane">
          <CodeEditor
            editorRef={editorRef}
            text={frozenSource}
            initialText={frozenSource}
            activeLine={hasMainSourceLocation ? location.line : 1}
            highlightLine={hasMainSourceLocation ? location.line : undefined}
            readOnly
            showActiveLine={hasMainSourceLocation}
            compactReadOnlyGutter
          />
        </main>
        <MemoryViewerRegions
          mode={mode}
          hasUsedHeap={hasUsedHeap}
          hasHeapAllocationCalls={hasHeapAllocationCalls}
          lifecycle={lifecycle}
          activeScopes={activeScopes}
          heapObjects={heapObjects}
          arrays={arrays}
          omittedArrayObjects={omittedArrayObjects}
          aggregates={aggregates}
          omittedAggregateObjects={omittedAggregateObjects}
          stackScalars={stackScalars}
          pointers={pointers}
          staticObjects={staticObjects}
          stepIndex={stepIndex}
          status={status}
        />
        <ConsolePanel
          className="memory-viewer-console"
          kind="debug"
          hidden={!showIoConsole}
          statusLabel={consoleStatus.label}
          statusTone={consoleStatus.tone}
          segments={consoleSegments}
          inputRequestId={inputRequestId}
          onSendStdinLine={sendStdinLine}
          onSendStdinEOF={sendStdinEOF}
          showStop={canStop}
          onStop={stop}
        />
      </div>
    </dialog>
  );
}
