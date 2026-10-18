import { Button } from './arc/button/button.tsx';
import { useI18n } from '../i18n.tsx';

export function LanguageSwitch() {
  const { language, setLanguage, t } = useI18n();
  const nextLanguage = language === 'en' ? 'es' : 'en';
  const label = t(language === 'en' ? 'language.switchToSpanish' : 'language.switchToEnglish');

  return (
    <Button
      className="language-switch-button"
      variant="ghost"
      size="sm"
      type="button"
      aria-label={label}
      aria-pressed={language === 'es'}
      title={label}
      onClick={() => setLanguage(nextLanguage)}
    >
      {language === 'en' ? 'ENG' : 'SPA'}
    </Button>
  );
}
