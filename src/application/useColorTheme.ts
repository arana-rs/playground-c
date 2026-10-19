import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

const THEME_SWEEP_DURATION_MS = 640;
const COLOR_THEME_STORAGE_KEY = 'c-playground-color-theme';

export type ColorTheme = 'github-dark' | 'github-light';

interface SameDocumentViewTransition {
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  finished: Promise<void>;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => SameDocumentViewTransition;
};

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function readColorTheme(): ColorTheme {
  try {
    return window.localStorage.getItem(COLOR_THEME_STORAGE_KEY) === 'github-light'
      ? 'github-light'
      : 'github-dark';
  } catch {
    return 'github-dark';
  }
}

const initialColorTheme = readColorTheme();
document.documentElement.dataset.theme = initialColorTheme;

export function useColorTheme() {
  const [colorTheme, setColorTheme] = useState<ColorTheme>(initialColorTheme);
  const requestedColorTheme = useRef(colorTheme);
  const themeTransitionGeneration = useRef(0);

  useLayoutEffect(() => {
    requestedColorTheme.current = colorTheme;
    document.documentElement.dataset.theme = colorTheme;
    try {
      window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, colorTheme);
    } catch {
      // Theme selection remains available when storage is disabled or full.
    }
  }, [colorTheme]);

  const changeColorTheme = useCallback((next: 'light' | 'dark', trigger: HTMLButtonElement) => {
    const requestedTheme = requestedColorTheme.current === colorTheme
      ? next === 'light' ? 'github-light' : 'github-dark'
      : requestedColorTheme.current === 'github-dark' ? 'github-light' : 'github-dark';
    if (requestedTheme === requestedColorTheme.current) return;
    requestedColorTheme.current = requestedTheme;

    const commitRequestedTheme = () => {
      flushSync(() => setColorTheme(requestedColorTheme.current));
    };
    const root = document.documentElement;
    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const viewTransitionDocument = document as ViewTransitionDocument;
    const startViewTransition = viewTransitionDocument.startViewTransition;

    if (!reducedMotion && typeof startViewTransition === 'function') {
      const bounds = trigger.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      const width = root.clientWidth || window.innerWidth;
      const height = root.clientHeight || window.innerHeight;
      const radius = Math.ceil(Math.hypot(Math.max(x, width - x), Math.max(y, height - y)));
      const generation = ++themeTransitionGeneration.current;
      const clearSweepOrigin = () => {
        if (generation !== themeTransitionGeneration.current) return;
        root.style.removeProperty('--theme-sweep-duration');
        root.style.removeProperty('--theme-sweep-x');
        root.style.removeProperty('--theme-sweep-y');
        root.style.removeProperty('--theme-sweep-radius');
      };

      root.style.setProperty('--theme-sweep-duration', `${THEME_SWEEP_DURATION_MS}ms`);
      root.style.setProperty('--theme-sweep-x', `${x}px`);
      root.style.setProperty('--theme-sweep-y', `${y}px`);
      root.style.setProperty('--theme-sweep-radius', `${radius}px`);

      try {
        const transition = startViewTransition.call(document, commitRequestedTheme);
        void transition.ready.catch(error => {
          if (!isAbortError(error)) console.error('Could not prepare the theme transition.', error);
        });
        void transition.updateCallbackDone.catch(error => {
          if (!isAbortError(error)) console.error('Could not apply the theme during the transition.', error);
          try {
            commitRequestedTheme();
          } catch (commitError) {
            clearSweepOrigin();
            console.error('Could not apply the theme after the transition failed.', commitError);
          }
        });
        void transition.finished.then(clearSweepOrigin, error => {
          clearSweepOrigin();
          if (!isAbortError(error)) console.error('The theme transition failed.', error);
        });
        return;
      } catch (error) {
        clearSweepOrigin();
        console.error('Could not start the theme transition.', error);
      }
    }

    commitRequestedTheme();
  }, [colorTheme]);

  return { colorTheme, changeColorTheme };
}
