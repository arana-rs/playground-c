import type { ReactNode, Ref } from 'react';
import type { MemoryRegion } from './MemoryViewerRegionModel.ts';

interface MemoryViewerRegionSectionProps {
  region: MemoryRegion;
  label: string;
  idPrefix: string;
  expanded: boolean;
  staticIsEmpty: boolean;
  heapIsEmpty: boolean;
  sectionRef: Ref<HTMLElement>;
  contentRef: Ref<HTMLDivElement>;
  onToggle: () => void;
  children: ReactNode;
}

export function MemoryViewerRegionSection({
  region,
  label,
  idPrefix,
  expanded,
  staticIsEmpty,
  heapIsEmpty,
  sectionRef,
  contentRef,
  onToggle,
  children,
}: MemoryViewerRegionSectionProps) {
  const headingId = `${idPrefix}-${region}-heading`;
  const contentId = `${idPrefix}-${region}-content`;

  return (
    <section
      className="memory-viewer-region"
      ref={sectionRef}
    >
      <h3 className="memory-viewer-region-heading">
        <button
          id={headingId}
          className="memory-viewer-region-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={onToggle}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="m4.5 6 3.5 3.5L11.5 6" />
          </svg>
          <span>{label}</span>
        </button>
      </h3>
      <div
        id={contentId}
        className={`memory-viewer-region-content${region === 'stack' ? ' memory-viewer-region-content--stack' : ''}${region === 'static' ? ` memory-viewer-region-content--static${staticIsEmpty ? ' memory-viewer-region-content--empty' : ''}` : ''}${region === 'heap' ? ` memory-viewer-region-content--heap${heapIsEmpty ? ' memory-viewer-region-content--empty' : ''}` : ''}`}
        ref={contentRef}
        role="region"
        aria-labelledby={headingId}
        hidden={!expanded}
      >
        {children}
      </div>
    </section>
  );
}
