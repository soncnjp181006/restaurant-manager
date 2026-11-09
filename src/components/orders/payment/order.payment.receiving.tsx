import ScrollContainer from "react-indiana-drag-scroll";
import {Button} from "@/components/common/input/button.tsx";
import {cn, DENOMINATION_COINS, DENOMINATION_NOTES, withCurrency} from "@/lib/utils.ts";
import {faBackspace, faClose, faPrint} from "@fortawesome/free-solid-svg-icons";
import * as React from "react";
import {useEffect, useMemo, useState} from "react";
import {PaymentType} from "@/api/model/payment_type.ts";
import {Order} from "@/api/model/order.ts";
import {useDB} from "@/api/db/db.ts";
import {Tax} from "@/api/model/tax.ts";
import {DiscountType} from "@/api/model/discount.ts";
import {Coupon} from "@/api/model/coupon.ts";
import {OrderPayment} from "@/api/model/order_payment.ts";
import {nanoid} from "nanoid";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {useAtom} from "jotai";
import {appAlert, appPage, appSettings} from "@/store/jotai.ts";
import {dispatchPrint} from "@/lib/print.service.ts";
import {PRINT_TYPE} from "@/lib/print.registry.tsx";
import {calculateChangeDue} from "@/lib/cart.ts";
import {posStore} from "@/infrastructure/pos-store/pos-store.ts";
import {terminalSyncService} from "@/infrastructure/sync/sync-service.ts";
import {
  isRemotePaymentType,
  RemotePaymentPendingSlot,
  RemotePaymentProvider,
  useRemotePayment,
} from "@/components/orders/payment/remote";
import {useSecurity} from "@/hooks/useSecurity.ts";
import {postOrderTracking} from "@/lib/tracking.service.ts";
import {useTranslation} from "react-i18next";
import {useIntegrationManager} from "@/providers/integration.provider.tsx";
import { hasTempPrint, requestBillPrint } from "@/lib/order-print.ts";
import { fetchOrderFull } from "@/lib/order-fetch.ts";
import {
  fiscalShouldBlockBeforePaid,
  loadOrderForFiscal,
  runFiscalSettlementForOrder,
} from "@/integrations/providers/fiscal/settlement.ts";
import { publishSaleCompleted } from "@/integrations/accounting/events/publish.ts";
import {
  publishInvoiceCreated,
  publishPaymentCompleted,
} from "@/integrations/events/publish/payments.ts";
import {toast} from "sonner";

interface Props {
  order: Order
  total: number
  resolvePayable: (taxOverride?: Tax | null, paymentTypeId?: string) => number
  onComplete: (opts?: { settled?: boolean }) => void

  extras: Record<string, number>

  setTax?: (tax?: Tax) => void;
  tax?: Tax
  taxAmount?: number

  discountAmount?: number
  /** Notify parent of selected tender so payment-gated discounts can evaluate */
  onPaymentTypeSelected?: (paymentTypeId: string) => void

  payments: OrderPayment[]
  setPayments: (paymentType: OrderPayment[] | ((prev: OrderPayment[]) => OrderPayment[])) => void;

  itemsTotal: number

  setServiceChargeAmount: (amt: number) => void
  serviceChargeAmount: number
  serviceCharge: number
  serviceChargeType: DiscountType

  notes: string
  coupon?: Coupon
  couponAmount?: number
}

type ContentProps = Props & {
  selectedAmount: string
  setSelectedAmount: React.Dispatch<React.SetStateAction<string>>
};

export const OrderPaymentReceiving = (props: Props) => {
  const [page] = useAtom(appPage);
  const [selectedAmount, setSelectedAmount] = useState("");

  return (
    <RemotePaymentProvider
      order={props.order}
      setPayments={props.setPayments}
      page={page?.page}
      user={page?.user}
      onRemotePaymentStarted={() => setSelectedAmount("")}
    >
      <OrderPaymentReceivingContent
        {...props}
        selectedAmount={selectedAmount}
        setSelectedAmount={setSelectedAmount}
      />
    </RemotePaymentProvider>
  );
};

const OrderPaymentReceivingContent = ({
  total,
  resolvePayable,
  order,
  onComplete,
  extras,
  setTax,
  tax,
  taxAmount,
  discountAmount,
  onPaymentTypeSelected,
  payments,
  setPayments,
  itemsTotal: _itemsTotal,
  serviceChargeAmount,
  serviceCharge,
  serviceChargeType,
  notes,
  coupon,
  couponAmount,
  selectedAmount,
  setSelectedAmount,
}: ContentProps) => {
  const {t} = useTranslation('payment');
  const remote = useRemotePayment();
  const db = useDB();
  const {protectAction} = useSecurity();
  const { manager: integrationManager } = useIntegrationManager();
  const [page] = useAtom(appPage);
  const [tempPrinted, setTempPrinted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void hasTempPrint(db, order.id.toString()).then((v) => {
      if (!cancelled) setTempPrinted(v);
    });
    return () => {
      cancelled = true;
    };
  }, [db, order.id]);

  const [, setAlert] = useAtom(appAlert);
  const [settings] = useAtom(appSettings);

  const tableId = order?.table?.id?.toString();

  const paymentTypes: PaymentType[] = useMemo(() => {
    if (tableId) {
      const table = settings.tables.find((row) => String(row.id) === tableId);
      if (table?.payment_types && table.payment_types.length > 0) {
        return table.payment_types as PaymentType[];
      }
    }
    return settings.payment_types ?? [];
  }, [settings.tables, settings.payment_types, tableId]);

  // const [paymentType, setPaymentType] = useState<string>();
  const [mode, setMode] = useState<'quick' | 'button'>('quick');

  const quickAmounts = [...DENOMINATION_COINS, ...DENOMINATION_NOTES];
  const keyboardKeys = [1, 2, 3, 4, 5, 6, 7, 8, 9, '.', 0];

  const [closing, setClosing] = useState(false);

  const isTaxObject = (value: unknown): value is Tax => {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as Tax).rate === 'number' &&
      typeof (value as Tax).name === 'string'
    );
  }

  const getPaymentTypeTax = (paymentType?: PaymentType): Tax | undefined => {
    return isTaxObject(paymentType?.tax) ? paymentType?.tax : undefined;
  }

  const closeOrder = async () => {
    setClosing(true);

    try {
      // Fiscal pre-check is an online integration concern; when the master DB is
      // unreachable we settle locally and let the post-settle fiscal run catch up.
      let blockBeforePaid = false;
      let fiscalOrderSnapshot: Order | undefined;
      let settledOrder = order;
      try {
        if (settledOrder.invoice_number == null) {
          await terminalSyncService.synchronize({ force: true }).catch(() => undefined);
          const local = await posStore.getOrder(String(settledOrder.id));
          if (local?.invoice_number != null) {
            settledOrder = { ...settledOrder, invoice_number: local.invoice_number } as Order;
          }
        }
        blockBeforePaid = await fiscalShouldBlockBeforePaid(integrationManager, db);
        if (blockBeforePaid) {
          fiscalOrderSnapshot = await loadOrderForFiscal(db, String(settledOrder.id));
          if (fiscalOrderSnapshot && settledOrder.invoice_number != null) {
            fiscalOrderSnapshot = {
              ...fiscalOrderSnapshot,
              invoice_number: settledOrder.invoice_number,
            };
          }
        }
      } catch (fiscalCheckError) {
        console.warn('Fiscal pre-check skipped (offline?)', fiscalCheckError);
        blockBeforePaid = false;
      }

      if (blockBeforePaid) {
        if (fiscalOrderSnapshot) {
          const preResult = await runFiscalSettlementForOrder(
            integrationManager,
            db,
            {
              ...fiscalOrderSnapshot,
              tax: tax ?? fiscalOrderSnapshot.tax,
              tax_amount: taxAmount ?? fiscalOrderSnapshot.tax_amount,
              discount_amount: discountAmount ?? fiscalOrderSnapshot.discount_amount,
              service_charge: serviceCharge,
              service_charge_amount: serviceChargeAmount,
              service_charge_type: serviceChargeType,
              payments: payments.length > 0 ? payments : fiscalOrderSnapshot.payments,
            }
          );
          if (preResult.blocked) {
            toast.error(
              preResult.blockedCode === 'INVOICE_PENDING'
                ? t('errors.invoicePendingSync')
                : (preResult.blockedError ?? t('errors.fiscalFailed')),
            );
            return;
          }
          if (Object.values(preResult.resultsByProvider).some((row) => row.status === 'failed')) {
            toast.warning(t('fiscalProvidersFailed'));
          }
        }
      }

      const orderId = String(order.id);
      const hasCoupon = !!(coupon && couponAmount && couponAmount > 0);
      const resolvedDiscountAmount = discountAmount ?? order.discount_amount ?? 0;
      const resolvedDiscountId = order.discount?.id ? String(order.discount.id) : undefined;
      const extraRows = Object.keys(extras).map((name) => ({
        id: `order_extras:${orderId.split(':')[1]}_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`,
        name,
        value: extras[name],
      }));

      // Local-first settlement: Dexie commit + outbox (CREATE_PAYMENT×n, MERGE order,
      // REPLACE taxes/extras, coupon + redemption). Works offline; drains when back.
      const settled = await posStore.settleOrder({
        orderId,
        payments: payments
          .filter((payment) => payment?.payment_type?.id && Number(payment.amount) > 0)
          .map((payment) => ({
            id: payment.id ? String(payment.id) : undefined,
            paymentTypeId: String(payment.payment_type.id),
            amount: Number(payment.amount),
            payable: Number(payment.payable ?? total),
            comments: payment.comments ?? null,
          })),
        cashierId: page?.user?.id ? String(page.user.id) : null,
        taxId: tax?.id ? String(tax.id) : null,
        serviceCharge,
        serviceChargeAmount,
        serviceChargeType,
        notes,
        discountAmount: resolvedDiscountAmount,
        ...(resolvedDiscountId ? { discountId: resolvedDiscountId } : {}),
        extras: extraRows,
        coupon: hasCoupon
          ? {
              id: order?.coupon?.id ? String(order.coupon.id) : undefined,
              couponId: String(coupon!.id),
              discount: Number(couponAmount),
            }
          : null,
        couponRedemption: hasCoupon
          ? {
              userId: page?.user?.id ? String(page.user.id) : null,
              discountAmount: Number(couponAmount),
            }
          : null,
        // Payment screen auto-saves draft + taxes — skip redundant work on settle.
        keepTaxes: true,
        skipDraft: true,
        seed: { order, items: order.items },
      });

      const settledPayments = payments.map((payment) => {
        const row = settled.payments.find(
          (p) => p.id === payment.id || p.id === `order_payment:${payment.id}`,
        );
        return row ? { ...payment, id: row.id as any } : payment;
      });
      setPayments(settledPayments);

      // Table is free once the check is settled.
      if (order?.table?.id) {
        void posStore.unlockTable(String(order.table.id)).catch(() => undefined);
      }

      postOrderTracking({
        module: "orders.complete_payment",
        page: page?.page,
        orderId: order.id,
        payload: {
          payment_count: payments.length,
          coupon: coupon?.id?.toString(),
          total,
        },
        user: page?.user,
      });

      // Post-settle side effects (fiscal, accounting, integration events) never
      // block the cashier; they wait for the outbox to drain so remote reads
      // see the settled order.
      void (async () => {
        try {
          await terminalSyncService.synchronize().catch(() => undefined);

          if (!blockBeforePaid) {
            const settledOrder = await loadOrderForFiscal(db, orderId);
            if (settledOrder) {
              const fiscalResult = await runFiscalSettlementForOrder(
                integrationManager,
                db,
                settledOrder
              );
              if (Object.values(fiscalResult.resultsByProvider).some((row) => row.status === 'failed')) {
                toast.warning(t('fiscalProvidersFailed'));
              }
            }
          }

          const saleOrder = await loadOrderForFiscal(db, orderId);
          if (saleOrder && integrationManager) {
            await publishSaleCompleted(integrationManager, saleOrder);
            await publishInvoiceCreated(integrationManager, {
              orderId: String(saleOrder.id),
              invoiceNumber: saleOrder.invoice_number,
              total: Number(saleOrder.payments?.reduce((s, p) => s + Number(p?.amount || 0), 0) || total),
              totalCollected: Number(saleOrder.payments?.reduce((s, p) => s + Number(p?.amount || 0), 0) || total),
              taxAmount: Number(saleOrder.tax_amount || taxAmount || 0),
              customerId: saleOrder.customer?.id
                ? String(saleOrder.customer.id)
                : undefined,
              completedAt: new Date().toISOString(),
            });
            for (const payment of settledPayments) {
              if (!payment?.id) continue;
              await publishPaymentCompleted(integrationManager, {
                paymentId: String(payment.id),
                orderId,
                amount: Number(payment.amount || 0),
                paymentTypeId: payment.payment_type?.id
                  ? String(payment.payment_type.id)
                  : undefined,
                paymentTypeName: payment.payment_type?.name,
              });
            }
          }
        } catch (sideEffectError) {
          console.warn('Post-settlement side effects failed', sideEffectError);
        }
      })();

      onComplete({ settled: true });
    } catch (e) {
      if ((e as any)?.code === 'ALREADY_CLOSED') {
        toast.error(t('receiving.alreadyClosed'));
        onComplete({ settled: true });
        return;
      }
      if ((e as any)?.code === 'NOT_OWNER') {
        toast.error(t('receiving.notOwner'));
        return;
      }
      throw e;
    } finally {
      setClosing(false);
    }
  }

  useEffect(() => {
    if (payments.length > 0) {
      // find largest tax and apply it
      const paymentsWithTaxes = payments.filter(item => !!getPaymentTypeTax(item.payment_type));
      let highest: Tax | undefined;
      if (paymentsWithTaxes.length > 0) {
        paymentsWithTaxes.forEach(pt => {
          const paymentTax = getPaymentTypeTax(pt.payment_type);
          if (!paymentTax) {
            return;
          }

          if (!highest) {
            highest = paymentTax;
          }

          if (highest.rate < paymentTax.rate) {
            highest = paymentTax;
          }
        });

        if (highest) {
          if (setTax) setTax(highest);
        }
      }
    }
  }, [setTax, payments]);

  const tendered = useMemo(() => {
    return payments.reduce((prev, item) => prev + item.amount, 0)
  }, [payments])

  const changeDue = useMemo(() => {
    return calculateChangeDue(tendered, total);
  }, [total, tendered]);

  const addPayment = async (amount: string | number, paymentType: PaymentType, payable: number) => {
    if (amount.toString().length === 0) {
      return;
    }

    if (isRemotePaymentType(paymentType)) {
      await remote.startRemotePayment(amount, paymentType, payable);
      return;
    }

    // Compute change due relative to this payable (may include tax for selected payment type)
    const localChangeDue = tendered - payable;

    if (paymentType.type === 'Card' && localChangeDue >= 0) {
      setAlert(prev => ({
        ...prev,
        opened: true,
        type: 'error',
        message: t('receiving.cannotAddCard')
      }));

      return;
    }

    if (paymentType.type === 'Card' && Number(amount) > Number(-1 * localChangeDue)) {
      setAlert(prev => ({
        ...prev,
        opened: true,
        type: 'warning',
        message: t('receiving.exactCardAmount')
      }));

      amount = -1 * localChangeDue;
    }

    setPayments(prev => [
      ...prev,
      {
        payment_type: paymentType,
        amount: Number(amount),
        payable: payable,
        id: nanoid()
      }
    ])
    setSelectedAmount('');
  }

  const getHighestTaxObject = (candidate?: Tax): Tax | undefined => {
    const existingTaxes = payments
      .map(p => getPaymentTypeTax(p.payment_type))
      .filter((paymentTax): paymentTax is Tax => !!paymentTax);
    let highest: Tax | undefined = existingTaxes.length > 0
      ? existingTaxes.reduce((acc, t) => (acc.rate >= t.rate ? acc : t))
      : undefined;
    if (candidate) {
      if (!highest || candidate.rate >= highest.rate) {
        highest = candidate;
      }
    }
    return highest;
  }

  const applyPaymentTypeTaxAndDiscount = (paymentType: PaymentType): number => {
    const paymentTypeId = String(paymentType.id);
    onPaymentTypeSelected?.(paymentTypeId);
    const candidateTax = getPaymentTypeTax(paymentType);
    const hasTax = !!candidateTax;
    const highestTax = hasTax ? getHighestTaxObject(candidateTax) : getHighestTaxObject(undefined);
    if (hasTax) {
      if (setTax) setTax(highestTax);
    }
    return resolvePayable(hasTax ? highestTax : undefined, paymentTypeId);
  }

  const allTaxes = settings.taxes;

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(280px,320px)] gap-3" data-testid="payment-receiving">
      <div
        className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-elevated"
        data-testid="payment-tender-panel"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              {t('receiving.entry', { defaultValue: 'Amount received' })}
            </div>
            <div
              className={cn(
                "mt-1 text-[30px] font-semibold leading-none tnum",
                selectedAmount.trim().length > 0 ? 'text-foreground' : 'text-muted/50',
              )}
              data-testid="payment-amount-entry"
            >
              {selectedAmount.trim().length > 0 ? selectedAmount : '0'}
            </div>
          </div>
          <div className="flex flex-shrink-0 gap-1">
            <button
              type="button"
              aria-label={t('receiving.backspace', { defaultValue: 'Backspace' })}
              className="btn btn-secondary btn-flat btn-square !h-8 !w-8"
              onClick={() => setSelectedAmount(prev => prev.slice(0, -1))}
            >
              <FontAwesomeIcon icon={faBackspace} className="text-[12px]" />
            </button>
            <button
              type="button"
              aria-label={t('receiving.clear', { defaultValue: 'Clear' })}
              className="btn btn-secondary btn-flat !h-8 px-2 text-[11.5px]"
              onClick={() => setSelectedAmount('')}
            >
              {t('receiving.clear', { defaultValue: 'Clear' })}
            </button>
          </div>
        </div>

        <div className="border-b border-border px-3 py-2.5" data-testid="payment-quick-amounts">
          <div className="grid grid-cols-4 gap-1.5">
            <button
              type="button"
              className="chip !h-8 justify-center !px-1 text-[11.5px] tnum"
              data-emphasis="primary"
              data-testid="payment-quick-exact"
              onClick={() => {
                if (!paymentTypes || paymentTypes.length === 0) {
                  return;
                }
                const pt = paymentTypes[0];
                const payable = applyPaymentTypeTaxAndDiscount(pt);
                void addPayment(payable, pt, payable);
                setMode('quick');
              }}
            >
              {withCurrency(total)}
            </button>
            {[...quickAmounts].sort((a, b) => a - b).map(item => (
              <button
                type="button"
                key={item}
                className="chip !h-8 justify-center !px-1 text-[11.5px] tnum"
                onClick={() => {
                  if (!paymentTypes || paymentTypes.length === 0) {
                    return;
                  }
                  const pt = paymentTypes[0];
                  const payable = applyPaymentTypeTaxAndDiscount(pt);
                  void addPayment(item, pt, payable);
                  setMode('quick');
                }}
              >
                {withCurrency(item)}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 p-3">
          <div className="keypad pay-keypad h-full" data-testid="payment-keypad">
            {keyboardKeys.map(item => (
              <button
                type="button"
                key={item}
                className="keypad-key"
                onClick={() => {
                  if (mode === 'button') {
                    setSelectedAmount((prev: string) => {
                      return prev + item.toString()
                    });
                  } else {
                    setSelectedAmount(item.toString());
                  }

                  setMode('button');
                }}
              >
                {item}
              </button>
            ))}
            <button
              type="button"
              className="keypad-key keypad-key--danger"
              onClick={() => setSelectedAmount('')}
            >
              C
            </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        <div className="rounded-[var(--radius-card)] border border-border bg-surface-elevated p-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              {t('receiving.due', { defaultValue: 'Amount due' })}
            </span>
            <span className="text-[11.5px] text-muted">
              {changeDue >= 0
                ? t('receiving.inFull', { defaultValue: 'Paid in full' })
                : payments.length > 0
                  ? t('receiving.partial', { defaultValue: 'Partial payment' })
                  : null}
            </span>
          </div>
          <div className="mt-1 text-[30px] font-semibold leading-none tracking-[-0.02em] tnum">
            {withCurrency(total)}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3">
            <div>
              <div className="text-[11px] text-muted">
                {t('receiving.tendered', { defaultValue: 'Tendered' })}
              </div>
              <div className="mt-0.5 text-[15px] font-semibold tnum" data-testid="payment-tendered">
                {withCurrency(tendered)}
              </div>
            </div>
            {payments.length > 0 && (
              <div className="text-right">
                <div
                  className={cn(
                    "text-[15px] font-semibold tnum",
                    changeDue < 0 ? 'text-danger' : changeDue > 0 ? 'text-success' : 'text-muted',
                  )}
                  data-testid="payment-change-due"
                >
                  <div className="text-[11px] font-normal text-muted">
                    {changeDue < 0 ? t('receiving.remaining') : t('receiving.change')}
                  </div>
                  {withCurrency(changeDue < 0 ? Math.abs(changeDue) : changeDue)}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-elevated">
          <div className="px-4 pb-1.5 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            {t('receiving.methods', { defaultValue: 'Payment method' })}
          </div>
          <div className="grid grid-cols-2 gap-1.5 px-3" data-testid="payment-types">
            {paymentTypes?.map(item => (
              <Button
                className="method-btn justify-center !text-[12.5px]"
                variant="secondary"
                key={item.id}
                data-testid="payment-type"
                onClick={() => {
                  const payable = applyPaymentTypeTaxAndDiscount(item);

                  if (selectedAmount.trim().length > 0) {
                    void addPayment(selectedAmount, item, payable)
                  } else if (changeDue < 0) {
                    const remaining = payable - tendered;
                    const amt = remaining.toString();
                    setSelectedAmount(amt);
                    void addPayment(amt, item, payable)
                  }
                }}
                size="lg"
              >
                {item.name}
              </Button>
            ))}
            {(!paymentTypes || paymentTypes.length === 0) && (
              <span className="col-span-2 px-1 py-2 text-[12px] text-muted">
                {t('receiving.noMethods', { defaultValue: 'No payment method configured.' })}
              </span>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between px-4 pb-1.5 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            <span>{t('receiving.added', { defaultValue: 'Taken' })}</span>
            <span className="tnum normal-case tracking-normal">{payments.length}</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 clean-scroll" data-testid="payment-lines">
            <RemotePaymentPendingSlot/>
            {payments.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1 px-4 py-6 text-center">
                <p className="text-[12.5px] text-muted">
                  {t('receiving.empty', { defaultValue: 'No payments yet' })}
                </p>
                <p className="text-[11.5px] text-muted/70">
                  {t('receiving.emptyHint', { defaultValue: 'Enter an amount, then choose a method.' })}
                </p>
              </div>
            ) : payments.map(payment => (
              <button
                type="button"
                className="group flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-danger/5"
                key={payment.id}
                data-testid="payment-line"
                onClick={() => {
                  setPayments(prev => prev.filter(item => item.id !== payment.id))
                }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FontAwesomeIcon
                    icon={faClose}
                    className="text-[9px] text-muted transition-colors group-hover:text-danger"
                  />
                  <span className="truncate text-[12.5px] font-medium">
                    {payment.payment_type.name}
                  </span>
                </span>
                <span className="flex-shrink-0 text-[12.5px] font-semibold tnum">
                  {withCurrency(payment.amount)}
                </span>
              </button>
            ))}
          </div>

          <div className="border-t border-border p-3" data-testid="payment-finish-actions">
            <Button
              variant="primary"
              filled
              size="lg"
              className="w-full"
              data-testid="payment-complete"
              isLoading={closing}
              onClick={async () => {
                await protectAction(async () => await closeOrder(), {
                  module: 'orders.complete',
                  description: 'Complete order',
                  payload: {
                    order: order.id.toString()
                  }
                });
              }}
              disabled={changeDue < 0 || closing || remote.isProcessing}
            >{t('receiving.complete')}</Button>
            <span
              title={tempPrinted ? t('receiving.tempAlreadyPrinted') : undefined}
              className="mt-1.5 flex"
            >
              <Button
                variant={tempPrinted ? "warning" : "secondary"}
                className="btn-flat w-full"
                flat
                icon={faPrint}
                size="lg"
                data-testid="payment-temp-bill"
                onClick={() => {
                  void requestBillPrint({
                    db,
                    protectAction,
                    orderId: order.id.toString(),
                    printType: 'temp',
                    printModule: 'orders.print_temp',
                    description: 'Print temp bill',
                    payload: { order: order.id.toString() },
                    userId: page?.user?.id?.toString?.() ?? page?.user?.id,
                    doPrint: async () => {
                      const full = await fetchOrderFull(db, order.id);
                      if (!full) {
                        throw new Error('Failed to load order for temp bill print');
                      }
                      await dispatchPrint(db, PRINT_TYPE.presale_bill, {
                        order: full,
                        taxes: allTaxes
                      }, {userId: page?.user?.id});
                      // Deliberately falsy (this callback's declared contract is
                      // `() => Promise<boolean>` and it always resolved to undefined
                      // here): requestBillPrint only records the print attempt and
                      // fires onPrinted for a truthy result, so returning
                      // dispatchPrint()'s boolean would start writing order_print
                      // rows and flip the temp-printed state. Needs sign-off.
                      return false;
                    },
                    onPrinted: () => setTempPrinted(true),
                  });
                }}
              >{t('receiving.tempBill')}</Button>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
