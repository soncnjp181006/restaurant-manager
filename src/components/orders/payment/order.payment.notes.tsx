import React from "react";
import { Textarea } from "@/components/common/input/textarea.tsx";
import { useTranslation } from "react-i18next";

interface Props {
  notes?: string
  setNotes: (notes?: string) => void
}

export const OrderPaymentNotes = ({
  notes, setNotes
}: Props) => {
  const { t } = useTranslation('payment');

  return (
    <div className="flex h-full flex-col gap-3" data-testid="payment-panel-notes">
      <div>
        <h4 className="text-[13.5px] font-semibold">{t('notes.title')}</h4>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">{t('notes.hint')}</p>
      </div>
      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.currentTarget.value)}
        enableKeyboard
        rows={7}
        className="flex-1 resize-none"
      />
    </div>
  );
};
