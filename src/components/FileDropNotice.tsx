import { useEffect, useRef } from 'react';
import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Button } from './arc/button/button.tsx';
import { useI18n } from '../i18n.tsx';
import type { TranslationValues } from '../i18n.tsx';
import type { TranslationKey } from '../i18n/en.ts';

export interface FileDropNoticeState {
  readonly id: number;
  readonly fileName: string;
  readonly messageKey: TranslationKey;
  readonly values?: TranslationValues;
  readonly tone: 'success' | 'warning' | 'error';
}

interface FileDropNoticeProps {
  notice: FileDropNoticeState | null;
  onDismiss: (id: number) => void;
}

const FILE_DROP_NOTICE_DURATION_MS = 6200;

export function FileDropNotice({ notice, onDismiss }: FileDropNoticeProps) {
  const { t } = useI18n();
  const pointerInsideRef = useRef(false);
  const focusWithinRef = useRef(false);
  const timerControlRef = useRef<{ pause: () => void; resume: () => void } | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!notice) {
      timerControlRef.current = null;
      pointerInsideRef.current = false;
      focusWithinRef.current = false;
      return;
    }

    let timer: number | null = null;
    let remainingMs = FILE_DROP_NOTICE_DURATION_MS;
    let timerStartedAt = 0;
    let disposed = false;

    const pauseTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
      remainingMs = Math.max(0, remainingMs - (Date.now() - timerStartedAt));
    };

    const resumeTimer = () => {
      if (disposed || timer !== null || pointerInsideRef.current || focusWithinRef.current) return;
      timerStartedAt = Date.now();
      timer = window.setTimeout(() => {
        timer = null;
        onDismissRef.current(notice.id);
      }, remainingMs);
    };

    timerControlRef.current = { pause: pauseTimer, resume: resumeTimer };
    resumeTimer();

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      if (timerControlRef.current?.pause === pauseTimer) timerControlRef.current = null;
    };
  }, [notice?.id]);

  const handlePointerEnter = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    pointerInsideRef.current = true;
    timerControlRef.current?.pause();
  };

  const handlePointerLeave = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    pointerInsideRef.current = false;
    if (!focusWithinRef.current) timerControlRef.current?.resume();
  };

  const handleFocusCapture = () => {
    focusWithinRef.current = true;
    timerControlRef.current?.pause();
  };

  const handleBlurCapture = (event: ReactFocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    focusWithinRef.current = false;
    if (!pointerInsideRef.current) timerControlRef.current?.resume();
  };

  if (!notice) return null;

  return (
    <div
      className={`file-drop-notice file-drop-notice--${notice.tone}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
    >
      <span className="file-drop-notice__message">
        {t(notice.messageKey, { file: notice.fileName, ...notice.values })}
      </span>
      <Button
        className="file-drop-notice__dismiss"
        variant="ghost"
        size="sm"
        type="button"
        aria-label={t('fileDrop.dismiss')}
        title={t('fileDrop.dismiss')}
        onClick={() => onDismiss(notice.id)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="m4 4 8 8M12 4l-8 8" />
        </svg>
      </Button>
    </div>
  );
}
