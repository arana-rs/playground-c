// Adapted from Arc UI Theme Switch: https://github.com/kuratlielia/arc-library/blob/main/registry/components/theme-switch/theme-switch.tsx
// MIT © 2026 Elia Kuratli; see LICENSE for the required notice.
"use client";

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { TargetAndTransition } from 'motion/react';
import { Button } from '../button/button.tsx';
import { motionTokens } from '../motion-tokens.ts';
import styles from './theme-switch.module.css';

export type Theme = 'light' | 'dark';

export interface ThemeSwitchProps {
  theme: Theme;
  className?: string;
  label: string;
  title?: string;
  onThemeChange: (next: Theme, trigger: HTMLButtonElement) => void;
}

const iconSpring = {
  ...motionTokens.spring.snappy,
  opacity: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.enter] },
  filter: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.enter] },
} as const;
const iconExit = { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] } as const;
const blur = `blur(${motionTokens.blur.subtle}px)`;

/** The persisted theme is known on the first paint, so only later changes animate. */
function useSettled() {
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setSettled(true));
    });

    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);

  return settled;
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6.5 6.5 0 0 0 8.268 8.268c.344-.215.825-.003.803.401" />
    </svg>
  );
}

function ThemeIcon({ theme, reduced, settled }: { theme: Theme; reduced: boolean; settled: boolean }) {
  const Icon = theme === 'light' ? SunIcon : MoonIcon;
  const angle = theme === 'light' ? 30 : -30;
  const initial: TargetAndTransition | false = !settled
    ? false
    : reduced
      ? { opacity: 0 }
      : { opacity: 0, scale: 0.7, rotate: angle, filter: blur };
  const exit: TargetAndTransition = !settled
    ? { opacity: 0, transition: { duration: 0 } }
    : reduced
      ? { opacity: 0, transition: { duration: motionTokens.duration.instant } }
      : { opacity: 0, scale: 0.7, rotate: angle, filter: blur, transition: iconExit };

  return (
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span
        key={theme}
        className={styles.icon}
        initial={initial}
        animate={{ opacity: 1, scale: 1, rotate: 0, filter: 'blur(0px)' }}
        exit={exit}
        transition={reduced ? { duration: motionTokens.duration.instant } : iconSpring}
        aria-hidden="true"
      >
        <Icon />
      </motion.span>
    </AnimatePresence>
  );
}

export function ThemeSwitch({ theme, className, label, title, onThemeChange }: ThemeSwitchProps) {
  const reduced = useReducedMotion() ?? false;
  const settled = useSettled();
  const next = theme === 'light' ? 'dark' : 'light';
  const classes = [styles.reveal, settled ? styles.settled : '', className].filter(Boolean).join(' ');

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={classes}
      data-theme={theme}
      aria-label={label}
      aria-pressed={theme === 'dark'}
      title={title ?? label}
      onClick={event => onThemeChange(next, event.currentTarget)}
    >
      <span className={styles.iconWrap}>
        <ThemeIcon theme={theme} reduced={reduced} settled={settled} />
      </span>
    </Button>
  );
}

export default ThemeSwitch;
