import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { filterMemoryViewerStaticScalars } from './arraySnapshots.ts';
import {
  resolveMemoryViewerPointerTarget,
  sameMemoryViewerPointerIdentity,
} from './pointerSnapshots.ts';
import type { MemoryViewerPointerIdentity } from './pointerSnapshots.ts';
import {
  findEntrypointMainRootScopeId,
  findMemoryViewerFunctionRootScopeIds,
} from './stackTransition.ts';
import { useStackHorizontalScroll } from './useStackHorizontalScroll.ts';
import { MemoryViewerExitCleanupTimer } from './exitCleanup.ts';
import {
  expandMemoryViewerPointerTargetRegion,
  hasMemoryViewerPointerIdentity,
  memoryViewerPointerInteractionTargetKey,
  memoryViewerPointerTargetRegion,
} from './MemoryViewerPointerTargets.ts';
import type { MemoryRegion, MemoryViewerRegionsProps } from './MemoryViewerRegionModel.ts';
import {
  EMPTY_EXIT_PRESENTATION,
  EMPTY_HEAP_EXIT_PRESENTATION,
  EMPTY_VALUE_CHANGE_PRESENTATION,
} from './MemoryViewerRegionModel.ts';
import type {
  MemoryViewerExitPresentation,
  MemoryViewerHeapExitPresentation,
  MemoryViewerValueChangePresentation,
} from './MemoryViewerRegionModel.ts';
import { useMemoryViewerRegionTransitions } from './useMemoryViewerRegionTransitions.ts';
import { MemoryViewerHeapContents } from './MemoryViewerHeapContents.tsx';
import { MemoryViewerRegionSection } from './MemoryViewerRegionSection.tsx';
import { MemoryViewerStackContents } from './MemoryViewerStackContents.tsx';
import { MemoryViewerStaticContents } from './MemoryViewerStaticContents.tsx';
import { useI18n } from '../i18n.tsx';

export function MemoryViewerRegions({
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
  const [exitPresentation, setExitPresentation] = useState<MemoryViewerExitPresentation>(EMPTY_EXIT_PRESENTATION);
  const [heapExitPresentation, setHeapExitPresentation] = useState<MemoryViewerHeapExitPresentation>(EMPTY_HEAP_EXIT_PRESENTATION);
  const [valueChangePresentation, setValueChangePresentation] = useState<MemoryViewerValueChangePresentation>(EMPTY_VALUE_CHANGE_PRESENTATION);

  function clearExitTimer() {
    exitTimerRef.current?.clear();
  }

  function clearHeapExitTimer() {
    heapExitTimerRef.current?.clear();
  }

  function resetExitPresentation() {
    setExitPresentation(EMPTY_EXIT_PRESENTATION);
  }

  function resetHeapExitPresentation() {
    setHeapExitPresentation(EMPTY_HEAP_EXIT_PRESENTATION);
  }

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

  useMemoryViewerRegionTransitions({
    status,
    stepIndex,
    activeScopes,
    heapObjects,
    arrays,
    aggregates,
    stackScalars,
    pointers,
    staticObjects,
    expandedHeap: expanded.heap,
    stackScrollRef,
    heapScrollRef,
    ensureVisible,
    ensureHeapVisible,
    cancelStackFollow,
    cancelHeapFollow,
    selectedSnapshotRef,
    heapFocusIdRef,
    exitTimerRef,
    heapExitTimerRef,
    exitPresentation,
    setExitPresentation,
    heapExitPresentation,
    setHeapExitPresentation,
    setValueChangePresentation,
  });

  useLayoutEffect(() => {
    if (!(hasHeapAllocationCalls || hasUsedHeap) || autoOpenedHeap.current) return;
    autoOpenedHeap.current = true;
    setExpanded(current => ({ ...current, heap: true }));
  }, [hasHeapAllocationCalls, hasUsedHeap]);

  useEffect(() => {
    if (expanded.stack) return;
    clearExitTimer();
    resetExitPresentation();
  }, [expanded.stack]);

  useEffect(() => {
    if (expanded.heap) return;
    clearHeapExitTimer();
    resetHeapExitPresentation();
  }, [expanded.heap]);

  useEffect(() => () => {
    clearExitTimer();
    clearHeapExitTimer();
  }, []);

  const staticIsEmpty = staticScalars.length === 0
    && !arrays.some(array => array.region === 'static')
    && !aggregates.some(aggregate => aggregate.region === 'static')
    && !pointers.some(pointer => pointer.region === 'static');
  const heapIsEmpty = heapObjects.length === 0
    && !aggregates.some(aggregate => aggregate.region === 'heap');

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
      <MemoryViewerRegionSection
        key="static"
        region="static"
        label="Static / TLS"
        idPrefix={idPrefix}
        expanded={expanded.static}
        staticIsEmpty={staticIsEmpty}
        heapIsEmpty={false}
        sectionRef={staticSectionRef}
        contentRef={staticScrollRef}
        onToggle={() => setExpanded(current => ({ ...current, static: !current.static }))}
      >
        <MemoryViewerStaticContents
          staticScalars={staticScalars}
          arrays={arrays}
          aggregates={aggregates}
          pointers={pointers}
          stepIndex={stepIndex}
          valueChangePresentation={valueChangePresentation}
          highlightedPointerTargetId={highlightedPointerTargetId}
          highlightedPointerTargetElementKey={highlightedPointerTargetElementKey}
          highlightedAggregateTargetId={highlightedAggregateTargetId}
          highlightedAggregateTargetFieldKey={highlightedAggregateTargetFieldKey}
          highlightedPointerTarget={highlightedPointerTarget}
          onPointerHoverChange={updatePointerHover}
          onPointerFocusChange={updatePointerFocus}
          t={t}
        />
      </MemoryViewerRegionSection>
      <MemoryViewerRegionSection
        key="stack"
        region="stack"
        label="Stack"
        idPrefix={idPrefix}
        expanded={expanded.stack}
        staticIsEmpty={false}
        heapIsEmpty={false}
        sectionRef={stackSectionRef}
        contentRef={stackScrollRef}
        onToggle={() => setExpanded(current => ({ ...current, stack: !current.stack }))}
      >
        <MemoryViewerStackContents
          mode={mode}
          activeScopes={activeScopes}
          arrays={arrays}
          aggregates={aggregates}
          pointers={pointers}
          stackScalars={stackScalars}
          entrypointMainRootScopeId={entrypointMainRootScopeIdRef.current}
          functionRootScopeIdsByFrame={functionRootScopeIdsByFrame}
          stepIndex={stepIndex}
          exitPresentation={exitPresentation}
          valueChangePresentation={valueChangePresentation}
          highlightedPointerTargetId={highlightedPointerTargetId}
          highlightedPointerTargetElementKey={highlightedPointerTargetElementKey}
          highlightedAggregateTargetId={highlightedAggregateTargetId}
          highlightedAggregateTargetFieldKey={highlightedAggregateTargetFieldKey}
          highlightedPointerTarget={highlightedPointerTarget}
          onPointerHoverChange={updatePointerHover}
          onPointerFocusChange={updatePointerFocus}
          t={t}
        />
      </MemoryViewerRegionSection>
      <MemoryViewerRegionSection
        key="heap"
        region="heap"
        label="Heap"
        idPrefix={idPrefix}
        expanded={expanded.heap}
        staticIsEmpty={false}
        heapIsEmpty={heapIsEmpty}
        sectionRef={heapSectionRef}
        contentRef={heapScrollRef}
        onToggle={() => setExpanded(current => ({ ...current, heap: !current.heap }))}
      >
        <MemoryViewerHeapContents
          heapObjects={heapObjects}
          aggregates={aggregates}
          stepIndex={stepIndex}
          heapExitPresentation={heapExitPresentation}
          valueChangePresentation={valueChangePresentation}
          highlightedAggregateTargetId={highlightedAggregateTargetId}
          highlightedAggregateTargetFieldKey={highlightedAggregateTargetFieldKey}
          highlightedPointerTarget={highlightedPointerTarget}
          onPointerHoverChange={updatePointerHover}
          onPointerFocusChange={updatePointerFocus}
          t={t}
        />
      </MemoryViewerRegionSection>
    </section>
  );
}
