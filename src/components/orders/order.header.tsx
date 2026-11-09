import { getTableLabel } from "@/api/model/table.ts";
import { Order, OrderStatus } from "@/api/model/order.ts";
import { cn } from "@/lib/utils.ts";
import {getInvoiceNumber, translateOrderStatus} from "@/lib/order.ts";
import {useTranslation} from "react-i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faPrint} from "@fortawesome/free-solid-svg-icons";

interface Props {
  order: Order
  tempPrinted?: boolean
}

export const OrderHeader = ({
  order,
  tempPrinted = false,
}: Props) => {
  const {t} = useTranslation('orders');

  const statusTone: Record<string, string> = {
    [OrderStatus["In Progress"]]: 'bg-warning/10 text-warning',
    [OrderStatus["Paid"]]: 'bg-success/10 text-success',
    [OrderStatus["Completed"]]: 'bg-success/10 text-success',
    [OrderStatus['Merged']]: 'bg-info/10 text-info',
    [OrderStatus['Spilt']]: 'bg-info/10 text-info',
    [OrderStatus['Cancelled']]: 'bg-danger/10 text-danger',
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {order?.table && (
            <span
              className="grid h-10 w-12 flex-shrink-0 place-items-center whitespace-nowrap rounded-lg px-1 text-[11px] font-semibold leading-tight"
              style={{
                color: order?.table?.color,
                background: order?.table?.background,
                boxShadow: 'inset 0 0 0 1px rgb(var(--border))'
              }}
            >
              {getTableLabel(order?.table)}
            </span>
          )}

          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-semibold leading-snug">
              {order?.order_type?.name
                ? t('header.orderNumber', {invoice: getInvoiceNumber(order), orderType: order.order_type.name})
                : t('header.orderNumberNoType', {invoice: getInvoiceNumber(order)})}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10.5px] font-medium leading-tight",
                  statusTone[order?.status]
                )}
              >
                {translateOrderStatus(t, order?.status)}
              </span>
              {order?.user?.first_name && (
                <span className="truncate text-[11.5px] text-muted">{order.user.first_name}</span>
              )}
            </div>
          </div>
        </div>

        {tempPrinted && (
          <span
            className="flex-shrink-0 text-[11px] text-warning"
            title={t('print.tempAlreadyPrinted')}
          >
            <FontAwesomeIcon icon={faPrint} />
          </span>
        )}
      </div>

      {order?.customer && (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px] text-muted">
          <span className="truncate font-medium text-foreground">{order?.customer?.name}</span>
          {order?.customer?.phone && <span className="tnum">{order?.customer?.phone}</span>}
        </div>
      )}
    </div>
  )
}
