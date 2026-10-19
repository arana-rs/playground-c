import type { CSSProperties } from 'react';
import type { DebugAggregateSnapshot, DebugArraySnapshot, DebugPointerSnapshot, DebugScalarSnapshot, MemoryViewerActiveScope } from './useMemoryViewer.ts';
import { MEMORY_VIEWER_SCOPE_NAME_MAX_CHARACTERS, isForBodyMemoryViewerScope, truncateMemoryViewerScopeName } from './scopeName.ts';
import { mergeExitedItemsInPreviousOrder } from './stackTransition.ts';
import { stackMemoryObjects } from './MemoryViewerRegionModel.ts';
import type { MemoryViewerExitPresentation, MemoryViewerStackObject, MemoryViewerValueChangePresentation, MemoryViewerMode } from './MemoryViewerRegionModel.ts';
import { pointerCardRecord, scalarCardRecord } from './MemoryViewerCardModel.ts';
import type { MemoryViewerScalarCardProps } from './MemoryViewerCardModel.ts';
import { MemoryViewerAggregateBlock } from './MemoryViewerAggregateBlock.tsx';
import { MemoryViewerArrayBlock } from './MemoryViewerArrayBlock.tsx';
import { MemoryViewerScalarCard } from './MemoryViewerScalarCard.tsx';
import type { MemoryViewerPointerTarget } from './pointerSnapshots.ts';
import type { Translate } from '../i18n.tsx';

const scopeNameFrameStyle = {
  '--memory-viewer-scope-name-height': `calc(${MEMORY_VIEWER_SCOPE_NAME_MAX_CHARACTERS}ch + 10px)`,
} as CSSProperties & { '--memory-viewer-scope-name-height': string };

interface MemoryViewerStackContentsProps {
  mode: MemoryViewerMode;
  activeScopes: readonly MemoryViewerActiveScope[];
  arrays: readonly DebugArraySnapshot[];
  aggregates: readonly DebugAggregateSnapshot[];
  pointers: readonly DebugPointerSnapshot[];
  stackScalars: readonly DebugScalarSnapshot[];
  entrypointMainRootScopeId: number | null;
  functionRootScopeIdsByFrame: ReadonlyMap<number, number>;
  stepIndex: number;
  exitPresentation: MemoryViewerExitPresentation;
  valueChangePresentation: MemoryViewerValueChangePresentation;
  highlightedPointerTargetId: number | null;
  highlightedPointerTargetElementKey: string | null;
  highlightedAggregateTargetId: number | null;
  highlightedAggregateTargetFieldKey: string | null;
  highlightedPointerTarget: MemoryViewerPointerTarget | null;
  onPointerHoverChange: NonNullable<MemoryViewerScalarCardProps['onPointerHoverChange']>;
  onPointerFocusChange: NonNullable<MemoryViewerScalarCardProps['onPointerFocusChange']>;
  t: Translate;
}

export function MemoryViewerStackContents({
  mode,
  activeScopes,
  arrays,
  aggregates,
  pointers,
  stackScalars,
  entrypointMainRootScopeId,
  functionRootScopeIdsByFrame,
  stepIndex,
  exitPresentation,
  valueChangePresentation,
  highlightedPointerTargetId,
  highlightedPointerTargetElementKey,
  highlightedAggregateTargetId,
  highlightedAggregateTargetFieldKey,
  highlightedPointerTarget,
  onPointerHoverChange,
  onPointerFocusChange,
  t,
}: MemoryViewerStackContentsProps) {

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
    const visibleScopes = displayedScopes.filter(scope => scope.id !== entrypointMainRootScopeId
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
              const isEntrypointMainRoot = scope.id === entrypointMainRootScopeId;
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
                        onPointerHoverChange={onPointerHoverChange}
                        onPointerFocusChange={onPointerFocusChange}
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
                        onPointerHoverChange={onPointerHoverChange}
                        onPointerFocusChange={onPointerFocusChange}
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
                        onPointerHoverChange={onPointerHoverChange}
                        onPointerFocusChange={onPointerFocusChange}
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
