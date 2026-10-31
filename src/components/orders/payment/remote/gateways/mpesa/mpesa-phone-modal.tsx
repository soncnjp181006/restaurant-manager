import { memo } from "react";
import { useTranslation } from 'react-i18next';
import { Button } from "@/components/common/input/button.tsx";
import { Input } from "@/components/common/input/input.tsx";
import { Modal } from "@/components/common/react-aria/modal.tsx";

type Props = {
  open: boolean;
  phoneInput: string;
  onPhoneChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isSubmitting?: boolean;
};

export const MpesaPhoneModal = memo(function MpesaPhoneModal({
  open,
  phoneInput,
  onPhoneChange,
  onConfirm,
  onCancel,
  isSubmitting,
}: Props) {
  const { t } = useTranslation('orders');
  return (
    <Modal
      open={open}
      onClose={isSubmitting ? () => {} : onCancel}
      title={t('mpesa.title')}
      size="sm"
      shouldCloseOnOverlayClick={!isSubmitting}
      shouldCloseOnEsc={!isSubmitting}
      hideCloseButton={isSubmitting}
    >
      <p className="text-sm text-muted mb-3">
        {isSubmitting
          ? t('mpesa.bodySending')
          : t('mpesa.bodyEnter')}
      </p>
      <Input
        label={t('mpesa.phone')}
        value={phoneInput}
        onChange={(e) => onPhoneChange(e.target.value)}
        placeholder="2547XXXXXXXX or 07XXXXXXXX"
        enableKeyboard
        inputSize="lg"
        disabled={isSubmitting}
        readOnly={isSubmitting}
      />
      <div className="flex gap-2 mt-4">
        <Button
          variant="secondary"
          className="flex-1"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          {t('mpesa.cancel')}
        </Button>
        <Button
          variant="primary"
          className="flex-1"
          onClick={onConfirm}
          disabled={isSubmitting}
        >
          {isSubmitting ? t('mpesa.sending') : t('mpesa.send')}
        </Button>
      </div>
    </Modal>
  );
});
