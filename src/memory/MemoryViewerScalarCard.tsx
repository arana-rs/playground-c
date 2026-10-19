import { useI18n } from '../i18n.tsx';
import type { MemoryViewerMetadataFooterProps, MemoryViewerScalarCardProps } from './MemoryViewerCardModel.ts';

export function MemoryViewerMetadataFooter({ name, type, size, readOnly = false, objectKind, wrapperClassName }: MemoryViewerMetadataFooterProps) {
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

export function MemoryViewerScalarCard({
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
