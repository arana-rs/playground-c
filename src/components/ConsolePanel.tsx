import { forwardRef, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, UIEvent as ReactUIEvent } from 'react';
import { Button } from './arc/button/button.tsx';
import { getPlaygroundShortcut } from '../keyboardShortcuts.ts';
import type { ConsoleOutputSegment, ConsoleStatusTone } from '../execution/useRunner.ts';
import { useI18n } from '../i18n.tsx';

interface ConsolePanelProps {
  readonly id?: string;
  readonly className?: string;
  readonly kind?: 'console' | 'debug';
  readonly ariaLabel?: string;
  readonly ariaKeyshortcuts?: string;
  readonly hidden?: boolean;
  readonly visible?: boolean;
  readonly inputResetKey?: string | number;
  readonly statusLabel: string;
  readonly statusTone: ConsoleStatusTone;
  readonly segments: readonly ConsoleOutputSegment[];
  readonly inputRequestId: number | null;
  readonly onSendStdinLine: (line: string) => boolean;
  readonly onSendStdinEOF: () => boolean;
  readonly showStop?: boolean;
  readonly onStop?: () => void;
  readonly actions?: ReactNode;
  readonly scrollKey?: string | number;
  readonly onInputFocus?: () => void;
  readonly onInputBlur?: () => void;
}

export const ConsolePanel = forwardRef<HTMLElement, ConsolePanelProps>(function ConsolePanel({
  id,
  className,
  kind = 'console',
  ariaLabel,
  ariaKeyshortcuts,
  hidden = false,
  visible = true,
  inputResetKey,
  statusLabel,
  statusTone,
  segments,
  inputRequestId,
  onSendStdinLine,
  onSendStdinEOF,
  showStop = false,
  onStop,
  actions,
  scrollKey,
  onInputFocus,
  onInputBlur,
}, forwardedRef) {
  const { t } = useI18n();
  const outputRef = useRef<HTMLPreElement>(null);
  const stdinRef = useRef<HTMLInputElement>(null);
  const previousInputRequest = useRef<number | null>(null);
  const previousInputResetKey = useRef(inputResetKey);
  const previousVisible = useRef(visible && !hidden);
  const shouldAutoScroll = useRef(true);
  const [stdinDraft, setStdinDraft] = useState('');
  const outputText = useMemo(() => segments.map(segment => segment.text).join(''), [segments]);

  useLayoutEffect(() => {
    const shown = visible && !hidden;
    if (previousInputResetKey.current !== inputResetKey) {
      previousInputResetKey.current = inputResetKey;
      shouldAutoScroll.current = true;
      setStdinDraft('');
    }
    const newRequest = inputRequestId !== null && inputRequestId !== previousInputRequest.current;
    const reopenedWhileWaiting = shown && !previousVisible.current && inputRequestId !== null;
    if (shown && (newRequest || reopenedWhileWaiting)) {
      stdinRef.current?.focus({ preventScroll: true });
    }
    previousInputRequest.current = inputRequestId;
    previousVisible.current = shown;
  }, [hidden, inputRequestId, inputResetKey, visible]);

  useLayoutEffect(() => {
    const output = outputRef.current;
    if (!output || !shouldAutoScroll.current) return;
    output.scrollTop = output.scrollHeight;
  }, [outputText, inputRequestId, stdinDraft, hidden, visible, scrollKey]);

  function onOutputScroll(event: ReactUIEvent<HTMLPreElement>) {
    const output = event.currentTarget;
    shouldAutoScroll.current = output.scrollHeight - output.clientHeight - output.scrollTop <= 16;
  }

  function onStdinKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    const nativeEvent = event.nativeEvent;
    if (!getPlaygroundShortcut(nativeEvent)) event.stopPropagation();
    if (event.key !== 'Enter' || event.repeat || nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (onSendStdinLine(stdinDraft)) setStdinDraft('');
  }

  return (
    <section
      ref={forwardedRef}
      id={id}
      className={`console${className ? ` ${className}` : ''}${inputRequestId !== null ? ' console-waiting' : ''}`}
      aria-label={ariaLabel ?? t(kind === 'debug' ? 'console.debugAriaLabel' : 'console.ariaLabel')}
      aria-keyshortcuts={ariaKeyshortcuts}
      aria-hidden={hidden || undefined}
      hidden={hidden}
      tabIndex={-1}
    >
      <div className="console-label">
        <span>{t(kind === 'debug' ? 'console.debugLabel' : 'console.label')}</span>
        <div className="console-actions">
          {inputRequestId !== null && (
            <Button
              className="console-eof-button"
              variant="ghost"
              size="sm"
              type="button"
              aria-label={t('console.sendEof')}
              onClick={onSendStdinEOF}
            >
              EOF
            </Button>
          )}
          {showStop && onStop && (
            <Button
              className="console-stop-button"
              variant="ghost"
              size="sm"
              type="button"
              aria-label={t('console.stopDebugging')}
              onClick={onStop}
            >
              {t('run.stop')}
            </Button>
          )}
          {actions}
          <span className={`console-status console-status-${statusTone}`} role="status" aria-live="polite" aria-atomic="true">
            {statusLabel}
          </span>
        </div>
      </div>
      <pre ref={outputRef} className="console-output" role="log" aria-live="off" aria-atomic="true" onScroll={onOutputScroll}>
        {segments.map((segment, index) => (
          <span key={index} className={`console-output-${segment.tone}`}>{segment.text}</span>
        ))}
        {inputRequestId !== null && (
          <input
            ref={stdinRef}
            className="console-stdin"
            aria-label={t('console.stdinLabel')}
            aria-description={t('console.stdinDescription')}
            aria-keyshortcuts="Enter"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={t('console.stdinPlaceholder')}
            value={stdinDraft}
            onChange={event => setStdinDraft(event.currentTarget.value)}
            onKeyDown={onStdinKeyDown}
            onFocus={onInputFocus}
            onBlur={onInputBlur}
          />
        )}
      </pre>
    </section>
  );
});
