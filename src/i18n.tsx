import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { messages as englishMessages } from './i18n/en.ts';
import { messages as spanishMessages } from './i18n/es.ts';
import type { TranslationKey } from './i18n/en.ts';

export type Language = 'en' | 'es';
export type TranslationValues = Readonly<Record<string, string | number>>;
export type Translate = (key: TranslationKey, values?: TranslationValues) => string;

export const LANGUAGE_STORAGE_KEY = 'c-playground-language';

type LanguageContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: Translate;
};

const languageMessages: Record<Language, Record<TranslationKey, string>> = {
  en: englishMessages,
  es: spanishMessages,
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'es';
}

export function readLanguage(
  storage: Pick<Storage, 'getItem'> | null | undefined,
  fallback: Language = 'en',
): Language {
  try {
    const storedLanguage = storage?.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(storedLanguage) ? storedLanguage : fallback;
  } catch {
    return fallback;
  }
}

export function writeLanguage(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  language: Language,
): boolean {
  try {
    storage?.setItem(LANGUAGE_STORAGE_KEY, language);
    return storage !== null && storage !== undefined;
  } catch {
    return false;
  }
}

export function formatMessage(language: Language, key: TranslationKey, values: TranslationValues = {}): string {
  const template = languageMessages[language][key];
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, name: string) => String(values[name.trim()] ?? ''));
}

function readBrowserLanguage(): Language {
  if (typeof window === 'undefined') return 'en';
  try {
    return readLanguage(window.localStorage);
  } catch {
    return 'en';
  }
}

export interface LanguageProviderProps {
  children: ReactNode;
  initialLanguage?: Language;
}

export function LanguageProvider({ children, initialLanguage }: LanguageProviderProps) {
  const [language, setLanguageState] = useState<Language>(() => initialLanguage ?? readBrowserLanguage());

  const setLanguage = useCallback((nextLanguage: Language) => {
    if (!isLanguage(nextLanguage)) return;
    setLanguageState(nextLanguage);
    if (typeof window !== 'undefined') {
      try {
        writeLanguage(window.localStorage, nextLanguage);
      } catch {
        // The selected language remains available when storage is disabled or full.
      }
    }
  }, []);

  const t = useCallback<Translate>((key, values) => formatMessage(language, key, values), [language]);

  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = language;
  }, [language]);

  const contextValue = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);
  return <LanguageContext.Provider value={contextValue}>{children}</LanguageContext.Provider>;
}

export function useI18n(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useI18n must be used within a LanguageProvider.');
  return context;
}
