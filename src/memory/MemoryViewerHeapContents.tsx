import type { DebugAggregateSnapshot, DebugHeapObjectSnapshot } from './useMemoryViewer.ts';
import { mergeMemoryViewerHeapObjects, mergeMemoryViewerHeapViews } from './heapSnapshots.ts';
import type { MemoryViewerHeapExitPresentation, MemoryViewerValueChangePresentation } from './MemoryViewerRegionModel.ts';
import { heapCardRecord } from './MemoryViewerCardModel.ts';
import type { MemoryViewerScalarCardProps } from './MemoryViewerCardModel.ts';
import { MemoryViewerAggregateBlock } from './MemoryViewerAggregateBlock.tsx';
import { MemoryViewerScalarCard } from './MemoryViewerScalarCard.tsx';
import type { MemoryViewerPointerTarget } from './pointerSnapshots.ts';
import type { Translate } from '../i18n.tsx';

interface MemoryViewerHeapContentsProps {
  heapObjects: readonly DebugHeapObjectSnapshot[];
  aggregates: readonly DebugAggregateSnapshot[];
  stepIndex: number;
  heapExitPresentation: MemoryViewerHeapExitPresentation;
  valueChangePresentation: MemoryViewerValueChangePresentation;
  highlightedAggregateTargetId: number | null;
  highlightedAggregateTargetFieldKey: string | null;
  highlightedPointerTarget: MemoryViewerPointerTarget | null;
  onPointerHoverChange: NonNullable<MemoryViewerScalarCardProps['onPointerHoverChange']>;
  onPointerFocusChange: NonNullable<MemoryViewerScalarCardProps['onPointerFocusChange']>;
  t: Translate;
}

export function MemoryViewerHeapContents({
  heapObjects,
  aggregates,
  stepIndex,
  heapExitPresentation,
  valueChangePresentation,
  highlightedAggregateTargetId,
  highlightedAggregateTargetFieldKey,
  highlightedPointerTarget,
  onPointerHoverChange,
  onPointerFocusChange,
  t,
}: MemoryViewerHeapContentsProps) {

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
                  onPointerHoverChange={onPointerHoverChange}
                  onPointerFocusChange={onPointerFocusChange}
                />
              )}
            </li>
          );
        })}
      </ol>
    );
}
