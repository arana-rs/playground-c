import type { DebugArrayElementSnapshot } from '@playground/c11-engine/core';
import type { DebugAggregateSnapshot } from './useMemoryViewer.ts';
import type { MemoryViewerPointerIdentity } from './pointerSnapshots.ts';
import { hasAnonymousAggregateMember } from './aggregateSnapshots.ts';
import { useI18n } from '../i18n.tsx';
import { arrayElementCardRecord } from './MemoryViewerCardModel.ts';
import type { MemoryViewerCardRecord } from './MemoryViewerCardModel.ts';
import { MemoryViewerMetadataFooter, MemoryViewerScalarCard } from './MemoryViewerScalarCard.tsx';
import { truncateMemoryViewerScalarValue } from './scalarValue.ts';
import type { Translate } from '../i18n.tsx';

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
