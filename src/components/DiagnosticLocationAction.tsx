import { useI18n } from '../i18n.tsx';

export type DiagnosticNavigationOutcome = 'navigated' | 'stale' | 'unavailable';

interface DiagnosticLocationActionProps {
  readonly text: string;
  readonly file: string;
  readonly currentFileName?: string;
  readonly line: number;
  readonly column: number;
  readonly available: boolean;
  readonly stale?: boolean;
  readonly onActivate?: () => void;
}

export function DiagnosticLocationAction({
  text,
  file,
  currentFileName,
  line,
  column,
  available,
  stale = false,
  onActivate,
}: DiagnosticLocationActionProps) {
  const { t } = useI18n();
  const targetFile = currentFileName ?? file;
  const values = { file: targetFile, line, column };
  const label = !available
    ? t('diagnostic.unavailable', values)
    : stale ? t('diagnostic.navigateStale', values) : t('diagnostic.navigate', values);

  return (
    <button
      className={`diagnostic-location-action${available ? '' : ' is-unavailable'}`}
      type="button"
      aria-label={label}
      aria-disabled={!available || undefined}
      title={label}
      onClick={available ? onActivate : undefined}
    >
      {text}
    </button>
  );
}
