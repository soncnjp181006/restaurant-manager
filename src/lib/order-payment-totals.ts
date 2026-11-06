import type { Order } from '@/api/model/order.ts';
import type { Tax } from '@/api/model/tax.ts';
import { DiscountType } from '@/api/model/discount.ts';
import { calculateOrderGrandTotal } from '@/lib/cart.ts';
import { recalculateCart } from '@/lib/discount-engine/recalculate.ts';
import { getDiscountCache } from '@/lib/discount-engine/cache.ts';
import type { AppliedDiscountLine } from '@/lib/discount-engine/types.ts';
import { calculateOrderPaymentTaxAmount } from '@/lib/tax-calculator.ts';

export interface OrderPaymentTotalsParams {
  tax?: Tax | null;
  discountLines: AppliedDiscountLine[];
  extras: Record<string, number>;
  serviceCharge: number;
  serviceChargeType: DiscountType;
  couponAmount: number;
  itemsTotal: number;
  /** Last selected payment type — enables payment-gated automatic discounts */
  paymentTypeId?: string;
}

export interface OrderPaymentTotalsResult {
  taxAmount: number;
  discountTotal: number;
  discountLines: AppliedDiscountLine[];
  serviceChargeAmount: number;
  grandTotal: number;
  total: number;
}

export const computeOrderPaymentTotals = (
  order: Order,
  params: OrderPaymentTotalsParams,
): OrderPaymentTotalsResult => {
  const {
    tax,
    discountLines,
    extras,
    serviceCharge,
    serviceChargeType,
    couponAmount,
    itemsTotal,
    paymentTypeId,
  } = params;

  const extrasTotal = Object.values(extras).reduce((prev, item) => prev + item, 0);
  const serviceChargeAmount = serviceCharge
    ? (serviceChargeType === DiscountType.Percent ? itemsTotal * serviceCharge / 100 : serviceCharge)
    : 0;
  const resolvedTax = tax ?? order.tax ?? null;

  const base = recalculateCart(order, {
    existingApplications: discountLines.filter(l => l.applicationType === 'manual'),
    manualRequests: [],
    extrasTotal,
    serviceChargeAmount,
    couponAmount,
    taxRate: resolvedTax?.rate,
    rules: getDiscountCache().all,
    paymentTypeId,
  });

  const resolvedTaxAmount = calculateOrderPaymentTaxAmount(order, resolvedTax);
  const taxDelta = resolvedTaxAmount - base.taxAmount;
  const grandTotal = base.grandTotal + taxDelta;

  const total = calculateOrderGrandTotal({
    itemsTotal,
    extrasTotal,
    taxAmount: resolvedTaxAmount,
    discountTotal: base.discountTotal,
    serviceChargeAmount,
    couponAmount,
  });

  return {
    taxAmount: resolvedTaxAmount,
    discountTotal: base.discountTotal,
    discountLines: base.discountLines,
    serviceChargeAmount,
    grandTotal,
    total,
  };
};
