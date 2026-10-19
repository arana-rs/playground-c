import type { EditorLimitMessage } from './limits.ts';
import { MAX_EDITOR_LINES } from './limits.ts';
import { useI18n } from '../i18n.tsx';

interface CodeEditorLimitStatusProps {
  limitMessage: EditorLimitMessage | null;
}

export function CodeEditorLimitStatus({ limitMessage }: CodeEditorLimitStatusProps) {
  const { t } = useI18n();

  return (
    <div
      className={limitMessage ? 'editor-limit-status is-visible' : 'editor-limit-status'}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {limitMessage?.kind === 'line-limit'
        ? t('editor.lineLimit', { max: MAX_EDITOR_LINES })
        : limitMessage?.kind === 'file-too-long'
          ? t('editor.fileTooLong', { count: limitMessage.lineCount, max: MAX_EDITOR_LINES })
          : ''}
    </div>
  );
}
