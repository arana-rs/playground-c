interface SelectedFileTabProps {
  fileName: string;
}

export function SelectedFileTab({ fileName }: SelectedFileTabProps) {
  return (
    <div className="selected-file-tab">
      <span className="selected-file-tab__name" aria-current="true">{fileName}</span>
      <button
        className="selected-file-tab__close"
        type="button"
        aria-label={`Cerrar ${fileName} (no disponible)`}
        disabled
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="m4 4 8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
