import { forwardRef } from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import type {
  DebugAggregateSnapshot,
  DebugArraySnapshot,
  DebugHeapObjectSnapshot,
  DebugPointerSnapshot,
} from './useMemoryViewer.ts';
import {
  memoryViewerHeapAliases,
  mergeMemoryViewerHeapObjects,
  mergeMemoryViewerHeapViews,
} from './heapSnapshots.ts';
import type { MemoryViewerHeapDisplayItem } from './heapSnapshots.ts';
import type { MemoryViewerHeapExitPresentation, MemoryViewerValueChangePresentation } from './MemoryViewerRegionModel.ts';
import { shouldDisplayMemoryViewerFreedHeapObject } from './MemoryViewerRegionModel.ts';
import { heapCardRecord } from './MemoryViewerCardModel.ts';
import type { MemoryViewerScalarCardProps } from './MemoryViewerCardModel.ts';
import { MemoryViewerAggregateBlock } from './MemoryViewerAggregateBlock.tsx';
import { MemoryViewerScalarCard } from './MemoryViewerScalarCard.tsx';
import type { MemoryViewerPointerTarget } from './pointerSnapshots.ts';
import type { Translate } from '../i18n.tsx';
import { motionTokens } from '../components/arc/motion-tokens.ts';

export const MEMORY_VIEWER_HEAP_EXIT_DURATION_MS = motionTokens.duration.standard * 1000;

interface MemoryViewerHeapContentsProps {
  heapObjects: readonly DebugHeapObjectSnapshot[];
  freedHeapObject: DebugHeapObjectSnapshot | null;
  pointers: readonly DebugPointerSnapshot[];
  arrays: readonly DebugArraySnapshot[];
  aggregates: readonly DebugAggregateSnapshot[];
  stepIndex: number;
  heapExitPresentation: MemoryViewerHeapExitPresentation;
  valueChangePresentation: MemoryViewerValueChangePresentation;
  highlightedAggregateTargetId: number | null;
  highlightedAggregateTargetFieldKey: string | null;
  highlightedPointerTarget: MemoryViewerPointerTarget | null;
  onPointerHoverChange: NonNullable<MemoryViewerScalarCardProps['onPointerHoverChange']>;
  onPointerFocusChange: NonNullable<MemoryViewerScalarCardProps['onPointerFocusChange']>;
  onFreedHeapExitComplete: () => void;
  t: Translate;
}

export function MemoryViewerHeapContents({
  heapObjects,
  freedHeapObject,
  pointers,
  arrays,
  aggregates,
  stepIndex,
  heapExitPresentation,
  valueChangePresentation,
  highlightedAggregateTargetId,
  highlightedAggregateTargetFieldKey,
  highlightedPointerTarget,
  onPointerHoverChange,
  onPointerFocusChange,
  onFreedHeapExitComplete,
  t,
}: MemoryViewerHeapContentsProps) {
  const prefersReducedMotion = useReducedMotion() ?? false;
  const presentedFreedObject = freedHeapObject ?? heapExitPresentation.deletedObjects.at(-1) ?? null;
  const shouldShowFreedObject = shouldDisplayMemoryViewerFreedHeapObject(presentedFreedObject, heapExitPresentation);
  const isCurrentExit = presentedFreedObject !== null
    && heapExitPresentation.deletedObjects.some(object => object.id === presentedFreedObject.id);
  const displayedObjects = mergeMemoryViewerHeapObjects(
    isCurrentExit ? heapExitPresentation.previousObjectIds : [],
    heapObjects,
    shouldShowFreedObject && presentedFreedObject ? [presentedFreedObject] : [],
  );
  const visibleItems = mergeMemoryViewerHeapViews(
    displayedObjects,
    aggregates.filter(aggregate => aggregate.region === 'heap'),
    heapObjects,
  );
  const heapAliases = memoryViewerHeapAliases(heapObjects, pointers, arrays, aggregates);
  const changedAggregateMemberKeys = new Set(valueChangePresentation.stepIndex === stepIndex
    ? valueChangePresentation.aggregateMemberKeys
    : []);
  const showEmptyState = visibleItems.length === 0 && heapExitPresentation.phase !== 'fading';

  return showEmptyState ? (
    <span className="memory-viewer-region-empty">{t('memoryViewer.empty')}</span>
  ) : (
    <ol
      className="memory-viewer-heap-list"
      aria-label={t('memoryViewer.heapBlocks')}
    >
      <AnimatePresence
        initial={false}
        mode="popLayout"
        onExitComplete={onFreedHeapExitComplete}
      >
        {visibleItems.map(item => (
          <MemoryViewerHeapItem
            key={`${item.kind}-${item.id}`}
            item={item}
            isFreedBlock={item.kind === 'block' && item.id === presentedFreedObject?.id}
            reducedMotion={prefersReducedMotion}
            heapAlias={item.kind === 'block'
              ? heapAliases.get(item.id)
              : heapAliases.get(item.snapshot.rootId)}
            changedAggregateMemberKeys={changedAggregateMemberKeys}
            highlightedAggregateTargetId={highlightedAggregateTargetId}
            highlightedAggregateTargetFieldKey={highlightedAggregateTargetFieldKey}
            highlightedPointerTarget={highlightedPointerTarget}
            onPointerHoverChange={onPointerHoverChange}
            onPointerFocusChange={onPointerFocusChange}
            t={t}
          />
        ))}
      </AnimatePresence>
    </ol>
  );
}

interface MemoryViewerHeapItemProps {
  item: MemoryViewerHeapDisplayItem;
  isFreedBlock: boolean;
  reducedMotion: boolean;
  heapAlias: string | undefined;
  changedAggregateMemberKeys: ReadonlySet<string>;
  highlightedAggregateTargetId: number | null;
  highlightedAggregateTargetFieldKey: string | null;
  highlightedPointerTarget: MemoryViewerPointerTarget | null;
  onPointerHoverChange: NonNullable<MemoryViewerScalarCardProps['onPointerHoverChange']>;
  onPointerFocusChange: NonNullable<MemoryViewerScalarCardProps['onPointerFocusChange']>;
  t: Translate;
}

const MemoryViewerHeapItem = forwardRef<HTMLLIElement, MemoryViewerHeapItemProps>(function MemoryViewerHeapItem({
  item,
  isFreedBlock,
  reducedMotion,
  heapAlias,
  changedAggregateMemberKeys,
  highlightedAggregateTargetId,
  highlightedAggregateTargetFieldKey,
  highlightedPointerTarget,
  onPointerHoverChange,
  onPointerFocusChange,
  t,
}, ref) {
  const isPresent = useIsPresent();

  return (
    <motion.li
      ref={ref}
      layout={reducedMotion ? false : 'position'}
      initial={false}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      exit={isFreedBlock && !reducedMotion
        ? {
          opacity: 0,
          scale: 0.84,
          x: 11,
          width: 0,
          height: 0,
          overflow: 'hidden',
          transition: {
            duration: MEMORY_VIEWER_HEAP_EXIT_DURATION_MS / 1000,
            ease: motionTokens.ease.exit,
          },
        }
        : { opacity: 0, transition: { duration: 0 } }}
      transition={reducedMotion
        ? { duration: 0 }
        : {
          duration: motionTokens.duration.standard,
          ease: motionTokens.ease.standard,
          layout: {
            duration: motionTokens.duration.standard,
            ease: motionTokens.ease.inOut,
          },
        }}
      aria-hidden={isPresent ? undefined : true}
      inert={!isPresent}
      style={{ pointerEvents: isPresent ? undefined : 'none', transformOrigin: 'center' }}
    >
      {item.kind === 'block' ? (
        <MemoryViewerScalarCard
          record={heapCardRecord(item.snapshot, t, heapAlias, isFreedBlock)}
        />
      ) : (
        <MemoryViewerAggregateBlock
          aggregate={item.snapshot}
          heapAliasLabel={heapAlias}
          changedMemberKeys={changedAggregateMemberKeys}
          pointerTargetFieldKey={item.id === highlightedAggregateTargetId ? highlightedAggregateTargetFieldKey : null}
          pointerTargetRoot={highlightedPointerTarget?.kind === 'aggregate-root' && item.id === highlightedAggregateTargetId}
          onPointerHoverChange={onPointerHoverChange}
          onPointerFocusChange={onPointerFocusChange}
        />
      )}
    </motion.li>
  );
});
