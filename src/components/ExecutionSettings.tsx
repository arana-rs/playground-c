import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ChangeEvent } from 'react';
import { Button } from './arc/button/button.tsx';
import { isPositiveSafeInteger } from '../execution/settings.ts';
import type { ExecutionSettings as ExecutionSettingsValue } from '../execution/settings.ts';
import { isMemoryViewerPlaybackInterval, MEMORY_VIEWER_PLAYBACK_SPEED_OPTIONS } from '../memory/playbackSpeed.ts';
import type { MemoryViewerPlaybackInterval } from '../memory/playbackSpeed.ts';
import { useI18n } from '../i18n.tsx';

type SettingsField = keyof ExecutionSettingsValue;
type DraftSettings = Record<SettingsField, string>;
type FieldErrors = Partial<Record<SettingsField, boolean>>;

interface ExecutionSettingsProps {
  value: ExecutionSettingsValue;
  playbackIntervalMs: MemoryViewerPlaybackInterval;
  onApply: (settings: ExecutionSettingsValue) => void;
  onPlaybackIntervalChange: (intervalMs: MemoryViewerPlaybackInterval) => void;
}

function toDraft(settings: ExecutionSettingsValue): DraftSettings {
  return {
    maxDepth: String(settings.maxDepth),
    maxInstructions: String(settings.maxInstructions),
  };
}

function parsePositiveSafeInteger(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return isPositiveSafeInteger(parsed) ? parsed : null;
}

export function ExecutionSettings({ value, playbackIntervalMs, onApply, onPlaybackIntervalChange }: ExecutionSettingsProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => toDraft(value));
  const [errors, setErrors] = useState<FieldErrors>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const playbackSpeedSelectRef = useRef<HTMLSelectElement>(null);
  const depthInputRef = useRef<HTMLInputElement>(null);
  const popoverId = useId();
  const depthHelpId = useId();
  const stepsHelpId = useId();
  const depthErrorId = useId();
  const stepsErrorId = useId();
  const playbackHelpId = useId();

  useEffect(() => {
    if (!open) return;
    playbackSpeedSelectRef.current?.focus({ preventScroll: true });

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setDraft(toDraft(value));
      setErrors({});
    }
  }, [open, value]);

  function changeDraft(field: SettingsField, event: ChangeEvent<HTMLInputElement>) {
    const nextValue = event.currentTarget.value;
    setDraft(current => ({ ...current, [field]: nextValue }));
    setErrors(current => ({ ...current, [field]: false }));
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const maxDepth = parsePositiveSafeInteger(draft.maxDepth);
    const maxInstructions = parsePositiveSafeInteger(draft.maxInstructions);
    const nextErrors = { maxDepth: maxDepth === null, maxInstructions: maxInstructions === null };
    setErrors(nextErrors);
    if (maxDepth === null || maxInstructions === null) {
      (maxDepth === null ? depthInputRef.current : rootRef.current?.querySelector<HTMLInputElement>('[name="maxInstructions"]'))
        ?.focus({ preventScroll: true });
      return;
    }

    onApply({ maxDepth, maxInstructions });
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  const depthInvalid = Boolean(errors.maxDepth);
  const stepsInvalid = Boolean(errors.maxInstructions);
  const label = t('executionSettings.open');

  return (
    <div className="execution-settings-anchor" ref={rootRef}>
      <Button
        ref={triggerRef}
        className="execution-settings-toggle"
        variant="ghost"
        size="sm"
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen(current => !current)}
        leadingIcon={(
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M6.35 1.5h3.3l.4 1.72c.32.12.62.29.9.5l1.68-.52 1.65 2.86-1.28 1.2c.04.34.04.68 0 1.02l1.28 1.2-1.65 2.86-1.68-.52c-.28.21-.58.38-.9.5l-.4 1.72h-3.3l-.4-1.72a4.7 4.7 0 0 1-.9-.5l-1.68.52-1.65-2.86L3 8.28a4.5 4.5 0 0 1 0-1.02l-1.28-1.2 1.65-2.86 1.68.52c.28-.21.58-.38.9-.5l.4-1.72Z" />
            <circle cx="8" cy="7.77" r="2.05" />
          </svg>
        )}
      />
      {open && (
        <section
          id={popoverId}
          className="execution-settings-popover"
          role="dialog"
          aria-labelledby={`${popoverId}-title`}
        >
          <div className="execution-settings-heading">
            <h2 id={`${popoverId}-title`}>{t('executionSettings.title')}</h2>
            <p>{t('executionSettings.description')}</p>
          </div>
          <form className="execution-settings-form" onSubmit={apply} noValidate>
            <label className="execution-settings-field execution-settings-playback-field" htmlFor={`${popoverId}-playback-speed`}>
              <span className="execution-settings-label">{t('executionSettings.playbackSpeed')}</span>
              <select
                ref={playbackSpeedSelectRef}
                id={`${popoverId}-playback-speed`}
                value={playbackIntervalMs}
                aria-describedby={playbackHelpId}
                onChange={event => {
                  const nextIntervalMs = Number(event.currentTarget.value);
                  if (isMemoryViewerPlaybackInterval(nextIntervalMs)) onPlaybackIntervalChange(nextIntervalMs);
                }}
              >
                {MEMORY_VIEWER_PLAYBACK_SPEED_OPTIONS.map(option => (
                  <option key={option.intervalMs} value={option.intervalMs}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </select>
              <span className="execution-settings-help" id={playbackHelpId}>{t('executionSettings.playbackSpeedHelp')}</span>
            </label>
            <label className="execution-settings-field" htmlFor={`${popoverId}-depth`}>
              <span className="execution-settings-label">{t('executionSettings.maxDepth')}</span>
              <input
                ref={depthInputRef}
                id={`${popoverId}-depth`}
                name="maxDepth"
                type="number"
                min="1"
                max="9007199254740991"
                step="1"
                required
                inputMode="numeric"
                value={draft.maxDepth}
                aria-invalid={depthInvalid || undefined}
                aria-describedby={`${depthHelpId}${depthInvalid ? ` ${depthErrorId}` : ''}`}
                onChange={event => changeDraft('maxDepth', event)}
              />
              <span className="execution-settings-help" id={depthHelpId}>{t('executionSettings.maxDepthHelp')}</span>
              {depthInvalid && <span className="execution-settings-error" id={depthErrorId}>{t('executionSettings.invalid')}</span>}
            </label>
            <label className="execution-settings-field" htmlFor={`${popoverId}-instructions`}>
              <span className="execution-settings-label">{t('executionSettings.maxInstructions')}</span>
              <input
                id={`${popoverId}-instructions`}
                name="maxInstructions"
                type="number"
                min="1"
                max="9007199254740991"
                step="1"
                required
                inputMode="numeric"
                value={draft.maxInstructions}
                aria-invalid={stepsInvalid || undefined}
                aria-describedby={`${stepsHelpId}${stepsInvalid ? ` ${stepsErrorId}` : ''}`}
                onChange={event => changeDraft('maxInstructions', event)}
              />
              <span className="execution-settings-help" id={stepsHelpId}>{t('executionSettings.maxInstructionsHelp')}</span>
              {stepsInvalid && <span className="execution-settings-error" id={stepsErrorId}>{t('executionSettings.invalid')}</span>}
            </label>
            <div className="execution-settings-actions">
              <Button className="execution-settings-apply-button" variant="secondary" size="sm" type="submit">
                {t('executionSettings.apply')}
              </Button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
