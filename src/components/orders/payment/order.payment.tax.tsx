import React, {useEffect, useState} from "react";
import {Tax} from "@/api/model/tax.ts";
import {Button} from "@/components/common/input/button.tsx";
import {cn} from "@/lib/utils.ts";
import {useTranslation} from "react-i18next";
import {useAtom} from "jotai";
import {appSettings} from "@/store/jotai.ts";
import {faCheck} from "@fortawesome/free-solid-svg-icons";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";

interface Props {
  tax?: Tax
  setTax: (tax?: Tax) => void
}

export const OrderPaymentTax = ({
  tax, setTax
}: Props) => {
  const {t} = useTranslation(['payment', 'common']);
  const [draftTax, setDraftTax] = useState<Tax | undefined>(tax);
  const [settings] = useAtom(appSettings);
  const taxes = settings.taxes ?? [];

  useEffect(() => {
    setDraftTax(tax);
  }, [tax]);

  const isActive = (candidate?: Tax) => {
    if (candidate === undefined) return draftTax === undefined;
    return draftTax?.id === candidate.id;
  };

  return (
    <div className="flex h-full flex-col" data-testid="payment-panel-tax">
      <p className="mb-2 text-[12px] leading-relaxed text-muted">
        {t('tax.hint', {defaultValue: 'Choose the tax rate applied to this order.'})}
      </p>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto clean-scroll">
        <button
          type="button"
          className={cn('option-row', isActive(undefined) && 'option-row--active')}
          aria-pressed={draftTax === undefined}
          onClick={() => setDraftTax(undefined)}
        >
          <span>{t('tax.noTax')}</span>
          <FontAwesomeIcon icon={faCheck} className="option-row-check" />
        </button>

        {taxes.map(item => (
          <button
            type="button"
            className={cn('option-row', isActive(item) && 'option-row--active')}
            aria-pressed={isActive(item)}
            onClick={() => setDraftTax(item)}
            key={item.id?.toString()}
          >
            <span className="min-w-0 truncate">{item.name}</span>
            <span className="flex flex-shrink-0 items-center gap-2 tnum">
              {item.rate}%
              <FontAwesomeIcon icon={faCheck} className="option-row-check" />
            </span>
          </button>
        ))}

        {taxes.length === 0 && (
          <p className="px-1 py-3 text-[12px] leading-relaxed text-muted">
            {t('tax.empty', { defaultValue: 'No tax configured for this terminal.' })}
          </p>
        )}
      </div>

      <div className="mt-3 border-t border-border pt-3">
        <Button variant="primary" filled size="lg" onClick={() => {
          setTax(draftTax)
        }} className="w-full" data-testid="payment-tax-apply">
          {t('common:actions.apply')}
        </Button>
      </div>
    </div>
  );
};
