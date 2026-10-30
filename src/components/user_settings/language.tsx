import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { appPage } from '@/store/jotai.ts';
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from '@/lib/languages.ts';
import {Button} from "@/components/common/input/button.tsx";

export const LanguageSettings = () => {
  const [page, setPage] = useAtom(appPage);
  const { t } = useTranslation('settings');
  const currentLanguage = page.language ?? DEFAULT_LANGUAGE;

  return (
    <div className="shadow p-5 rounded-xl bg-surface-elevated" data-testid="settings-card-language">
      <div className="flex items-start mb-5">
        <div>
          <h2 className="text-xl font-semibold mb-1">{t('language.title')}</h2>
          <p className="text-sm text-muted">{t('language.description')}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {SUPPORTED_LANGUAGES.map((lang) => (
          <Button
            key={lang.code}
            type="button"
            variant="primary"
            className={currentLanguage === lang.code
              ? 'active'
              : ''
            }
            size="lg"
            onClick={() => {
              setPage((prev) => ({
                ...prev,
                language: lang.code,
              }));
            }}
          >
            {lang.label}
          </Button>
        ))}
      </div>
    </div>
  );
};
