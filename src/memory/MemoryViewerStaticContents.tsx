import type { DebugAggregateSnapshot, DebugArraySnapshot, DebugPointerSnapshot, DebugStaticObjectSnapshot } from './useMemoryViewer.ts';
import { staticMemoryObjects } from './MemoryViewerRegionModel.ts';
import type { MemoryViewerValueChangePresentation } from './MemoryViewerRegionModel.ts';
import { pointerCardRecord, scalarCardRecord } from './MemoryViewerCardModel.ts';
import type { MemoryViewerScalarCardProps } from './MemoryViewerCardModel.ts';
import { MemoryViewerAggregateBlock } from './MemoryViewerAggregateBlock.tsx';
import { MemoryViewerArrayBlock } from './MemoryViewerArrayBlock.tsx';
import { MemoryViewerScalarCard } from './MemoryViewerScalarCard.tsx';
import type { MemoryViewerPointerTarget } from './pointerSnapshots.ts';
import type { Translate } from '../i18n.tsx';

interface MemoryViewerStaticContentsProps {
  staticScalars: readonly DebugStaticObjectSnapshot[];
  arrays: readonly DebugArraySnapshot[];
  aggregates: readonly DebugAggregateSnapshot[];
  pointers: readonly DebugPointerSnapshot[];
  stepIndex: number;
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

export function MemoryViewerStaticContents({
  staticScalars,
  arrays,
  aggregates,
  pointers,
  stepIndex,
  valueChangePresentation,
  highlightedPointerTargetId,
  highlightedPointerTargetElementKey,
  highlightedAggregateTargetId,
  highlightedAggregateTargetFieldKey,
  highlightedPointerTarget,
  onPointerHoverChange,
  onPointerFocusChange,
  t,
}: MemoryViewerStaticContentsProps) {

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
                onPointerHoverChange={onPointerHoverChange}
                onPointerFocusChange={onPointerFocusChange}
              />
            ) : item.kind === 'array' ? (
              <MemoryViewerArrayBlock
                array={item.snapshot}
                changedElementKeys={changedArrayElementKeys}
                pointerTargetElementKey={highlightedPointerTargetElementKey}
                onPointerHoverChange={onPointerHoverChange}
                onPointerFocusChange={onPointerFocusChange}
              />
            ) : (
              <MemoryViewerAggregateBlock
                aggregate={item.snapshot}
                changedMemberKeys={changedAggregateMemberKeys}
                pointerTargetFieldKey={item.id === highlightedAggregateTargetId ? highlightedAggregateTargetFieldKey : null}
                pointerTargetRoot={highlightedPointerTarget?.kind === 'aggregate-root'
                  && item.id === highlightedAggregateTargetId}
                onPointerHoverChange={onPointerHoverChange}
                onPointerFocusChange={onPointerFocusChange}
              />
            )}
          </li>
        ))}
      </ol>
    );
}
