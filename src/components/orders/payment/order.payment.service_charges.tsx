import {Button} from "@/components/common/input/button.tsx";
import React, {useEffect, useMemo, useRef, useState} from "react";
import {DiscountType} from "@/api/model/discount.ts";
import {cn, withCurrency} from "@/lib/utils.ts";
import {Order} from "@/api/model/order.ts";
import {useTranslation} from "react-i18next";
import {useAtom} from "jotai";
import {appSettings} from "@/store/jotai.ts";

interface Props {
  serviceCharge: number
  setServiceCharge: (charges: any) => void

  setServiceChargeType: (type: DiscountType) => void
  serviceChargeType: DiscountType

  order: Order
}

export const OrderPaymentServiceCharges = ({
  serviceCharge, setServiceCharge, serviceChargeType, setServiceChargeType, order
}: Props) => {
  const {t} = useTranslation(['payment', 'common']);
  const [settings] = useAtom(appSettings);
  const [draftServiceCharge, setDraftServiceCharge] = useState<number>(serviceCharge);
  const [draftServiceChargeType, setDraftServiceChargeType] = useState<DiscountType>(serviceChargeType);
  const defaultAppliedRef = useRef(false);

  const [quickPercentOptions, setQuickPercentOptions] = useState([
    3, 5, 12
  ]);

  const keyboardKeys = [1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0];

  const serviceChargeSetting = useMemo(() => {
    return (settings.settings ?? []).find(
      (row) => row.key === 'service_charges' && (row.is_global === true || row.is_global == null),
    );
  }, [settings.settings]);

  const defaultFromSettings = useMemo(() => {
    const values = serviceChargeSetting?.values as any;
    const typeRaw = values?.type?.value ?? values?.type;
    const valueRaw = values?.value?.value ?? values?.value;
    const type = String(typeRaw || DiscountType.Percent) === DiscountType.Fixed ? DiscountType.Fixed : DiscountType.Percent;
    const value = Number(valueRaw || 0);

    return {
      value,
      type,
      label: type === DiscountType.Fixed ? `${withCurrency(value)}` : `${value}%`
    };
  }, [serviceChargeSetting]);

  useEffect(() => {
    setDraftServiceCharge(serviceCharge);
    setDraftServiceChargeType(serviceChargeType);
    defaultAppliedRef.current = false;
  }, [serviceCharge, serviceChargeType]);

  useEffect(() => {
    if (defaultFromSettings.value <= 0) {
      return;
    }

    setQuickPercentOptions(prev => {
      const optionsSet = new Set(prev);
      optionsSet.add(defaultFromSettings.value);
      return Array.from(optionsSet);
    });
  }, [defaultFromSettings.value]);

  const allowServiceCharges = order.order_type?.allow_service_charges === true;

  useEffect(() => {
    if (
      defaultAppliedRef.current ||
      serviceCharge !== 0 ||
      !allowServiceCharges ||
      defaultFromSettings.value <= 0
    ) {
      return;
    }

    setDraftServiceCharge(defaultFromSettings.value);
    setDraftServiceChargeType(defaultFromSettings.type);
    defaultAppliedRef.current = true;
  }, [defaultFromSettings, allowServiceCharges, serviceCharge]);

  return (
    <div className="flex h-full flex-col" data-testid="payment-panel-service-charges">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto clean-scroll">
        <div className="rounded-lg border border-warning/25 bg-warning/8 px-3 py-2 text-[12px] leading-relaxed">
          {t('serviceCharges.defaultFromSettings')}{' '}
          <span className="font-semibold">{defaultFromSettings.label}</span>
        </div>

        <button
          type="button"
          className={cn('option-row', draftServiceCharge === 0 && 'option-row--active')}
          aria-pressed={draftServiceCharge === 0}
          onClick={() => setDraftServiceCharge(0)}
        >
          <span>{t('serviceCharges.noServiceCharge')}</span>
        </button>

        <div className="grid grid-cols-3 gap-1.5">
          {quickPercentOptions.map(item => (
            <button
              type="button"
              key={item}
              className="chip !h-9 justify-center tnum"
              data-active={draftServiceCharge === item && draftServiceChargeType === DiscountType.Percent}
              onClick={() => {
                setDraftServiceCharge(item);
                setDraftServiceChargeType(DiscountType.Percent);
              }}
            >
              {item}%
            </button>
          ))}
        </div>

        <div className="rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2 text-right text-[22px] font-semibold tnum">
          {draftServiceChargeType === DiscountType.Percent
            ? `${draftServiceCharge}%`
            : withCurrency(draftServiceCharge)}
        </div>

        <div className="pay-keypad" style={{gridAutoRows: '44px', height: 'auto'}}>
          {keyboardKeys.map((item, index) => (
            item === '' ? <span key={`empty-${index}`} /> : (
              <button
                type="button"
                className="keypad-key"
                key={index}
                onClick={() => {
                  setDraftServiceChargeType(DiscountType.Fixed);
                  setDraftServiceCharge(Number(`${draftServiceChargeType === DiscountType.Fixed ? draftServiceCharge : ''}${item}`));
                }}
              >
                {item}
              </button>
            )
          ))}
          <button
            type="button"
            className="keypad-key keypad-key--danger"
            onClick={() => {
              setDraftServiceCharge(0);
              setDraftServiceChargeType(DiscountType.Fixed);
            }}
          >
            C
          </button>
        </div>
      </div>

      <div className="mt-3 border-t border-border pt-3">
        <Button
          variant="primary"
          filled
          size="lg"
          className="w-full"
          data-testid="payment-service-charges-apply"
          onClick={() => {
            setServiceCharge(draftServiceCharge);
            setServiceChargeType(draftServiceChargeType);
          }}
        >
          {t('common:actions.apply')}
        </Button>
      </div>
    </div>
  );
};
