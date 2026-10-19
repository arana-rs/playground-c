import type { DebugArraySnapshot } from './useMemoryViewer.ts';
import type { MemoryViewerPointerIdentity } from './pointerSnapshots.ts';
import { useI18n } from '../i18n.tsx';
import type { Translate } from '../i18n.tsx';
import { arrayElementCardRecord } from './MemoryViewerCardModel.ts';
import { MemoryViewerMetadataFooter, MemoryViewerScalarCard } from './MemoryViewerScalarCard.tsx';

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
