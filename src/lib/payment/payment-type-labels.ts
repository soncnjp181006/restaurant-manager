/**
 * `payment_type.type` is a stored enum: payment logic compares the raw strings
 * (`paymentType.type === 'Card'`, cash-drawer filters on `'cash'`), so the value
 * is never localised — only the label shown to the operator is.
 */
export const PAYMENT_TYPE_VALUES = ['Cash', 'Card', 'Points', 'Remote'] as const;

export type PaymentTypeValue = (typeof PAYMENT_TYPE_VALUES)[number];

/** Translated label for a stored type; unknown or legacy values render as-is. */
export const getPaymentTypeLabel = (
  t: (key: string) => string,
  value?: string | null,
): string => {
  if (!value) return '';
  return (PAYMENT_TYPE_VALUES as readonly string[]).includes(value)
    ? t(`paymentTypes.${value}`)
    : value;
};
