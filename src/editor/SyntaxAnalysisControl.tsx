import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Button } from '../components/arc/button/button.tsx';
import { useI18n } from '../i18n.tsx';
import type { SyntaxAnalysisState } from './syntaxAnalysisController.ts';
import type { SyntaxAnalysisMode } from './syntaxAnalysisPreference.ts';

const modes: readonly SyntaxAnalysisMode[] = ['off', 'syntax'];

function OffIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="5.8" />
    <path d="m4 4 8 8" />
  </svg>;
}

function getStatusText(
  mode: SyntaxAnalysisMode,
  state: SyntaxAnalysisState,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (mode === 'off' || state.status === 'off') return t('syntaxAnalysis.state.off');
  switch (state.status) {
    case 'analyzing': return t('syntaxAnalysis.state.analyzing');
    case 'ok': return t('syntaxAnalysis.state.ok');
    case 'analysis-errors': {
      const count = state.truncated ? `${state.diagnosticCount}+` : state.diagnosticCount;
      return state.diagnosticCount === 1 && !state.truncated
        ? t('syntaxAnalysis.state.errorOne')
        : t('syntaxAnalysis.state.errors', { count });
    }
    case 'limit': return t('syntaxAnalysis.state.limit', { resource: state.resource });
    case 'unavailable': return t('syntaxAnalysis.state.unavailable');
    case 'timeout': return t('syntaxAnalysis.state.timeout');
  }
}

function getVisibleStatus(
  mode: SyntaxAnalysisMode,
  state: SyntaxAnalysisState,
  t: ReturnType<typeof useI18n>['t'],
) {
  if (mode === 'off' || state.status === 'off') {
    return <OffIcon />;
  }
  switch (state.status) {
    case 'analyzing':
      return <>
        <span className="syntax-analysis-spinner" aria-hidden="true" />
        <span>{t('syntaxAnalysis.state.analyzing')}</span>
      </>;
    case 'ok':
      return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m3 8.2 3.2 3.1L13 4.8" /></svg>;
    case 'analysis-errors':
      return <>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 2.2 14 13H2L8 2.2Z" /><path d="M8 5.8v3.3M8 11.2h.01" /></svg>
        <span>{state.truncated ? `${state.diagnosticCount}+` : state.diagnosticCount}</span>
      </>;
    case 'limit':
      return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 2.2 14 13H2L8 2.2Z" /><path d="M8 5.8v3.3M8 11.2h.01" /></svg>;
    case 'unavailable':
      return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="5.8" /><path d="M8 4.7v3.6M8 11h.01" /></svg>;
    case 'timeout':
      return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="5.8" /><path d="M8 4.7v3.6M8 11h.01" /></svg>;
  }
}

export function SyntaxAnalysisControl({
  mode,
  state,
  onModeChange,
}: {
  mode: SyntaxAnalysisMode;
  state: SyntaxAnalysisState;
  onModeChange: (mode: SyntaxAnalysisMode) => void;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = modes.indexOf(mode);
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(selectedIndex);
  const displayState = mode === 'syntax' && state.status === 'off'
    ? { status: 'analyzing' as const }
    : state;
  const statusText = getStatusText(mode, displayState, t);

  const openMenu = useCallback(() => {
    setFocusIndex(selectedIndex);
    setOpen(true);
  }, [selectedIndex]);

  useLayoutEffect(() => {
    if (open) optionRefs.current[focusIndex]?.focus();
  }, [open, focusIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const chooseMode = useCallback((nextMode: SyntaxAnalysisMode) => {
    onModeChange(nextMode);
    setOpen(false);
    triggerRef.current?.focus();
  }, [onModeChange]);

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openMenu();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      window.setTimeout(() => setOpen(false), 0);
      return;
    }
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = (focusIndex + 1) % modes.length;
    else if (event.key === 'ArrowUp') nextIndex = (focusIndex + modes.length - 1) % modes.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = modes.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setFocusIndex(nextIndex);
  };

  const title = t('syntaxAnalysis.trigger', { status: statusText });

  return (
    <div ref={rootRef} className="syntax-analysis-control">
      <Button
        ref={triggerRef}
        className="syntax-analysis-trigger"
        variant="ghost"
        size="sm"
        type="button"
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={`syntax-analysis-status is-${mode === 'off' ? 'off' : displayState.status}`} aria-hidden="true">
          {getVisibleStatus(mode, displayState, t)}
        </span>
      </Button>
      <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{title}</span>
      {open && (
        <div
          className="syntax-analysis-menu"
          role="menu"
          aria-label={t('syntaxAnalysis.menu')}
          onKeyDown={onMenuKeyDown}
        >
          {modes.map((option, index) => (
            <Button
              key={option}
              ref={node => { optionRefs.current[index] = node; }}
              className="syntax-analysis-option"
              variant="ghost"
              size="sm"
              type="button"
              role="menuitemradio"
              aria-checked={mode === option}
              tabIndex={focusIndex === index ? 0 : -1}
              onFocus={() => setFocusIndex(index)}
              onClick={() => chooseMode(option)}
            >
              <span className="syntax-analysis-option-mark" aria-hidden="true">
                {mode === option ? '✓' : ''}
              </span>
              {t(option === 'off' ? 'syntaxAnalysis.optionOff' : 'syntaxAnalysis.optionSyntax')}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
