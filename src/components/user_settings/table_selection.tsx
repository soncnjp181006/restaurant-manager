import {Button} from "@/components/common/input/button.tsx";
import {useAtom} from "jotai";
import {appState} from "@/store/jotai.ts";
import {useTranslation} from 'react-i18next';

export const TableSelectionSettings = () => {
  const [state, setState] = useAtom(appState);
  const { t } = useTranslation(['settings', 'common']);

  return (
    <div className="rounded-2xl border border-border/70 bg-surface-elevated/80 backdrop-blur p-5 shadow-[var(--elev-2)]" data-testid="settings-card-table-selection">
      <div className="flex items-start mb-5">
        <div>
          <h2 className="text-xl font-semibold mb-1">{t('settings:tableSelection.title')}</h2>
          <p className="text-sm text-muted">
            {t('settings:tableSelection.description')}
          </p>
        </div>
      </div>
      <Button
        variant={state.hideTableSelection ? 'success' : 'danger'}
        size="lg"
        onClick={() => {
          setState(prev => ({
            ...prev,
            hideTableSelection: !prev.hideTableSelection,
          }));
        }}
      >
        {state.hideTableSelection ? t('common:actions.enabled') : t('common:actions.disabled')}
      </Button>
    </div>
  );
};
