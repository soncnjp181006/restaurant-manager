import { useTranslation } from 'react-i18next';
import {REPORTS_PURCHASE_ORDER} from "@/routes/restaurant-manager.ts";
import {DateRange} from "@/components/reports/filters/date.range.tsx";
import {Button} from "@/components/common/input/button.tsx";
import {ReactSelect} from "@/components/common/input/custom.react.select.tsx";
import useApi, {SettingsData} from "@/api/db/use.api.ts";
import {Tables} from "@/api/db/tables.ts";
import {InventorySupplier} from "@/api/model/inventory_supplier.ts";
import {InventoryItem} from "@/api/model/inventory_item.ts";
import {User} from "@/api/model/user.ts";
import {PurchaseOrderStatus} from "@/api/model/inventory_purchase_order.ts";

const toOption = <T extends { id?: any }>(
  item: T | undefined,
  label: string
) => {
  if (!item?.id) {
    return null;
  }

  const value =
    typeof item.id === "string" ? item.id : item.id.toString?.() ?? String(item.id);

  return {
    label,
    value,
  };
};

const notNull = <T,>(value: T | null | undefined): value is T =>
  value !== null && value !== undefined;

const PURCHASE_ORDER_STATUS_KEYS: Record<PurchaseOrderStatus, string> = {
  [PurchaseOrderStatus.draft]: 'filters.poStatusDraft',
  [PurchaseOrderStatus.pendingApproval]: 'filters.poStatusPendingApproval',
  [PurchaseOrderStatus.approved]: 'filters.poStatusApproved',
  [PurchaseOrderStatus.fulfilled]: 'filters.poStatusFulfilled',
};

export const PurchaseOrderFilter = () => {
  const { t } = useTranslation('reports');
  // Labels are built per render: a module-level map would freeze the language.
  const statusOptions = Object.values(PurchaseOrderStatus).map((status) => ({
    label: t(PURCHASE_ORDER_STATUS_KEYS[status]),
    value: status,
  }));
  const {data: suppliersData, isLoading: loadingSuppliers} = useApi<SettingsData<InventorySupplier>>(Tables.inventory_suppliers, [], ['name asc'], 0, 9999);
  const {data: itemsData, isLoading: loadingItems} = useApi<SettingsData<InventoryItem>>(Tables.inventory_items, [], ['name asc'], 0, 9999);
  const {data: usersData, isLoading: loadingUsers} = useApi<SettingsData<User>>(Tables.users, [], ['first_name asc'], 0, 9999);

  return (
    <form
      action={REPORTS_PURCHASE_ORDER}
      className="flex flex-col gap-4 items-start w-full"
      target="_blank"
    >
      <DateRange isRequired label={t('filters.selectRange')} />

      <div className="w-full flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="purchase-order-statuses" className="form-label">{t('columns.status')}</label>
          <ReactSelect
            id="purchase-order-statuses"
            name="statuses[]"
            isMulti
            className="w-full"
            options={statusOptions}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="purchase-order-suppliers" className="form-label">{t('filters.supplier')}</label>
          <ReactSelect
            id="purchase-order-suppliers"
            name="suppliers[]"
            isMulti
            isLoading={loadingSuppliers}
            className="w-full"
            options={(suppliersData?.data || [])
              .map(supplier => toOption(supplier, supplier.name))
              .filter(notNull)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="purchase-order-items" className="form-label">{t('columns.items')}</label>
          <ReactSelect
            id="purchase-order-items"
            name="items[]"
            isMulti
            isLoading={loadingItems}
            className="w-full"
            options={(itemsData?.data || [])
              .map(item => toOption(item, item.name))
              .filter(notNull)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="purchase-order-users" className="form-label">{t('columns.createdBy')}</label>
          <ReactSelect
            id="purchase-order-users"
            name="users[]"
            isMulti
            isLoading={loadingUsers}
            className="w-full"
            options={(usersData?.data || [])
              .map(user =>
                toOption(user, `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || user.login || 'Unnamed user')
              )
              .filter(notNull)}
          />
        </div>
      </div>

      <Button
        variant="primary"
        filled
        type="submit"
      >{t('filters.generate')}</Button>
    </form>
  );
};
