import { useLayoutEffect } from 'react';
import type { SetStateAction } from 'react';
import type { useStackHorizontalScroll } from './useStackHorizontalScroll.ts';
import type {
  DebugAggregateSnapshot,
  DebugHeapObjectSnapshot,
  DebugArraySnapshot,
  DebugPointerSnapshot,
  DebugScalarSnapshot,
  DebugStaticObjectSnapshot,
  MemoryViewerActiveScope,
} from './useMemoryViewer.ts';
import type { useMemoryViewer } from './useMemoryViewer.ts';
import { findMemoryViewerChangedArrayElementKeys } from './arraySnapshots.ts';
import { findMemoryViewerChangedAggregateMemberKeys } from './aggregateSnapshots.ts';
import { findMemoryViewerChangedPointerIds } from './pointerSnapshots.ts';
import {
  chooseMemoryViewerStackFocusId,
  compareMemoryViewerStackSnapshots,
  findMemoryViewerChangedScalarIds,
} from './stackTransition.ts';
import { MemoryViewerExitCleanupTimer, readMemoryViewerExitDuration } from './exitCleanup.ts';
import { chooseMemoryViewerHeapFocusId, compareMemoryViewerHeapObjects } from './heapSnapshots.ts';
import { completeMemoryViewerHeapExitPresentation, resolveMemoryViewerHeapExitPresentation, stackMemoryObjects } from './MemoryViewerRegionModel.ts';
import { EMPTY_EXIT_PRESENTATION, EMPTY_HEAP_EXIT_PRESENTATION, EMPTY_VALUE_CHANGE_PRESENTATION } from './MemoryViewerRegionModel.ts';
import type { MemoryViewerExitPresentation, MemoryViewerHeapExitPresentation, MemoryViewerValueChangePresentation } from './MemoryViewerRegionModel.ts';

type StackScrollController = ReturnType<typeof useStackHorizontalScroll>;

interface MemoryViewerSelectedSnapshot {
  stepIndex: number;
  activeScopes: readonly MemoryViewerActiveScope[];
  heapObjects: readonly DebugHeapObjectSnapshot[];
  freedHeapObject: DebugHeapObjectSnapshot | null;
  arrays: readonly DebugArraySnapshot[];
  aggregates: readonly DebugAggregateSnapshot[];
  stackScalars: readonly DebugScalarSnapshot[];
  pointers: readonly DebugPointerSnapshot[];
  staticObjects: readonly DebugStaticObjectSnapshot[];
}

interface UseMemoryViewerRegionTransitionsProps {
  status: ReturnType<typeof useMemoryViewer>['status'];
  stepIndex: number;
  activeScopes: readonly MemoryViewerActiveScope[];
  heapObjects: readonly DebugHeapObjectSnapshot[];
  freedHeapObject: DebugHeapObjectSnapshot | null;
  arrays: readonly DebugArraySnapshot[];
  aggregates: readonly DebugAggregateSnapshot[];
  stackScalars: readonly DebugScalarSnapshot[];
  pointers: readonly DebugPointerSnapshot[];
  staticObjects: readonly DebugStaticObjectSnapshot[];
  expandedHeap: boolean;
  stackScrollRef: StackScrollController['stackScrollRef'];
  heapScrollRef: StackScrollController['stackScrollRef'];
  ensureVisible: StackScrollController['ensureVisible'];
  ensureHeapVisible: StackScrollController['ensureVisible'];
  cancelStackFollow: StackScrollController['cancelPendingFollow'];
  cancelHeapFollow: StackScrollController['cancelPendingFollow'];
  selectedSnapshotRef: { current: MemoryViewerSelectedSnapshot };
  heapFocusIdRef: { current: number | null };
  exitTimerRef: { current: MemoryViewerExitCleanupTimer | null };
  exitPresentation: MemoryViewerExitPresentation;
  setExitPresentation: (value: SetStateAction<MemoryViewerExitPresentation>) => void;
  heapExitPresentation: MemoryViewerHeapExitPresentation;
  setHeapExitPresentation: (value: SetStateAction<MemoryViewerHeapExitPresentation>) => void;
  setValueChangePresentation: (value: SetStateAction<MemoryViewerValueChangePresentation>) => void;
}

export function useMemoryViewerRegionTransitions({
  status,
  stepIndex,
  activeScopes,
  heapObjects,
  freedHeapObject,
  arrays,
  aggregates,
  stackScalars,
  pointers,
  staticObjects,
  expandedHeap,
  stackScrollRef,
  heapScrollRef,
  ensureVisible,
  ensureHeapVisible,
  cancelStackFollow,
  cancelHeapFollow,
  selectedSnapshotRef,
  heapFocusIdRef,
  exitTimerRef,
  exitPresentation,
  setExitPresentation,
  heapExitPresentation,
  setHeapExitPresentation,
  setValueChangePresentation,
}: UseMemoryViewerRegionTransitionsProps) {
  function clearExitTimer() {
    exitTimerRef.current?.clear();
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

  function finishHeapExitTransition(transitionStep: number, targetExists = true) {
    if (!targetExists) {
      setHeapExitPresentation(current => current.stepIndex === transitionStep && current.phase === 'waiting'
        ? completeMemoryViewerHeapExitPresentation(current)
        : current);
      return;
    }

    setHeapExitPresentation(current => current.stepIndex === transitionStep && current.phase === 'waiting'
      ? { ...current, phase: 'fading' }
      : current);
  }

  useLayoutEffect(() => {
    const previous = selectedSnapshotRef.current;
    const current = { stepIndex, activeScopes, heapObjects, freedHeapObject, arrays, aggregates, stackScalars, pointers, staticObjects };
    selectedSnapshotRef.current = current;

    if (status === 'starting' && stepIndex === 0) {
      selectedSnapshotRef.current = { ...current, freedHeapObject: null };
      cancelStackFollow();
      cancelHeapFollow();
      heapFocusIdRef.current = null;
      clearExitTimer();
      setExitPresentation(EMPTY_EXIT_PRESENTATION);
      setHeapExitPresentation(EMPTY_HEAP_EXIT_PRESENTATION);
      setValueChangePresentation(EMPTY_VALUE_CHANGE_PRESENTATION);
      return;
    }
    const freedObjectChanged = previous.freedHeapObject?.id !== freedHeapObject?.id;
    if (previous.stepIndex === stepIndex) {
      if (freedObjectChanged) {
        setHeapExitPresentation(resolveMemoryViewerHeapExitPresentation(
          heapExitPresentation,
          previous.freedHeapObject,
          freedHeapObject,
          stepIndex,
          previous.heapObjects,
        ));
      }
      return;
    }

    clearExitTimer();
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
      setHeapExitPresentation(resolveMemoryViewerHeapExitPresentation(
        heapExitPresentation,
        previous.freedHeapObject,
        freedHeapObject,
        stepIndex,
        previous.heapObjects,
      ));
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
    setHeapExitPresentation(resolveMemoryViewerHeapExitPresentation(
      heapExitPresentation,
      previous.freedHeapObject,
      freedHeapObject,
      stepIndex,
      previous.heapObjects,
      freedHeapObject === null ? heapTransition.deleted.at(-1) ?? null : null,
    ));
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
  }, [activeScopes, aggregates, arrays, cancelHeapFollow, cancelStackFollow, freedHeapObject, heapExitPresentation, heapObjects, pointers, stackScalars, staticObjects, status, stepIndex]);

  useLayoutEffect(() => {
    if (!expandedHeap) return;
    const presentedReleaseId = freedHeapObject?.id ?? heapExitPresentation.deletedObjects.at(-1)?.id ?? null;
    const hasCurrentHeapExit = presentedReleaseId !== null
      && heapExitPresentation.deletedObjects.some(object => object.id === presentedReleaseId)
      && heapExitPresentation.phase === 'waiting';
    const focusId = hasCurrentHeapExit ? heapExitPresentation.focusId : heapFocusIdRef.current;
    if (focusId === null) return;

    const target = heapScrollRef.current?.querySelector<HTMLElement>(
      `[data-memory-viewer-scalar-id="${focusId}"]`,
    );
    if (!target) {
      if (hasCurrentHeapExit) finishHeapExitTransition(heapExitPresentation.stepIndex, false);
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
      () => finishHeapExitTransition(heapExitPresentation.stepIndex),
    );
  }, [ensureHeapVisible, expandedHeap, freedHeapObject, heapExitPresentation, heapObjects, heapScrollRef, stepIndex]);

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

}
