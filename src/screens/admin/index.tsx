import { TabList, Tabs } from "react-aria-components";
import { Layout } from "@/screens/partials/layout.tsx";
import { Tab, TabPanel } from "@/components/common/react-aria/tabs";
import { useMemo, useState, useEffect } from "react";
import { AdminFloors } from "@/components/settings/floors";
import { AdminTables } from "@/components/settings/tables";
import { AdminSelfOrder } from "@/components/settings/self_order";
import { AdminDishes } from "@/components/settings/dishes";
import { AdminCategories } from "@/components/settings/categories";
import { AdminModifierGroups } from "@/components/settings/modifier_groups";
import { AdminDiscounts } from "@/components/settings/discounts";
import { AdminKitchens } from "@/components/settings/kitchens";
import { AdminWorkflows } from "@/components/settings/workflows";
import { AdminPrinters } from "@/components/settings/printers";
import { AdminOrderTypes } from "@/components/settings/order_types";
import { AdminPaymentTypes } from "@/components/settings/payment_types";
import { AdminTaxes } from "@/components/settings/taxes";
import { AdminUsers } from "@/components/settings/users";
import { SecurityAlertsPanel } from "@/components/admin/security-alerts";
import { CatalogPublishPanel } from "@/components/settings/catalog_publish";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronLeft, faChevronRight } from "@fortawesome/free-solid-svg-icons";
import {AdminMenus} from "@/components/settings/menu";
import {AdminPrints} from "@/components/settings/prints";
import { AdminExtras } from "@/components/settings/extras";
import { AdminCoupons } from "@/components/settings/coupons";
import {useSecurity} from "@/hooks/useSecurity.ts";
import {useTranslation} from 'react-i18next';
import {DocumentTitle} from "@/components/common/document-title.tsx";
import {filterPagesByBuildModule, firstPageKey} from "@/lib/build-modules.ts";

const CATALOG_PUBLISH_ENABLED =
  String(import.meta.env.VITE_CATALOG_PUBLISH_ENABLED || '').toLowerCase() === 'true';

const BASE_ADMIN_TAB_KEYS = [
  'dishes',
  'menus',
  'categories',
  'modifier_groups',
  'tables',
  'qr_ordering',
  'floors',
  'discounts',
  'coupons',
  'kitchens',
  'workflows',
  'printers',
  'print_settings',
  'order_types',
  'payment_types',
  'extras',
  'taxes',
  'users',
  'security_alerts',
] as const;

type BaseAdminTabKey = (typeof BASE_ADMIN_TAB_KEYS)[number];
type AdminTabKey = BaseAdminTabKey | 'catalog_publish';

const ADMIN_TAB_KEYS: AdminTabKey[] = CATALOG_PUBLISH_ENABLED
  ? [...BASE_ADMIN_TAB_KEYS, 'catalog_publish']
  : [...BASE_ADMIN_TAB_KEYS];

const TAB_I18N_KEYS: Record<AdminTabKey, string> = {
  dishes: 'tabs.dishes',
  menus: 'tabs.menus',
  categories: 'tabs.categories',
  modifier_groups: 'tabs.modifierGroups',
  tables: 'tabs.tables',
  qr_ordering: 'tabs.qrOrdering',
  floors: 'tabs.floors',
  discounts: 'tabs.discounts',
  coupons: 'tabs.coupons',
  kitchens: 'tabs.kitchens',
  workflows: 'tabs.workflows',
  printers: 'tabs.printers',
  print_settings: 'tabs.printSettings',
  order_types: 'tabs.orderTypes',
  payment_types: 'tabs.paymentTypes',
  extras: 'tabs.extras',
  taxes: 'tabs.taxes',
  users: 'tabs.users',
  security_alerts: 'tabs.securityAlerts',
  catalog_publish: 'tabs.catalogPublish',
};

/** Stable permission codes stored in user roles — not translated labels. */
const ADMIN_TAB_MODULES: Record<AdminTabKey, string> = {
  dishes: 'admin.dishes',
  menus: 'admin.menus',
  categories: 'admin.categories',
  modifier_groups: 'admin.modifier_groups',
  tables: 'admin.tables',
  /** Role access still shares tables; build filter uses ADMIN_TAB_BUILD_MODULES. */
  qr_ordering: 'admin.tables',
  floors: 'admin.floors',
  discounts: 'admin.discounts',
  coupons: 'admin.coupons',
  kitchens: 'admin.kitchens',
  workflows: 'admin.workflows',
  printers: 'admin.printers',
  print_settings: 'admin.print_settings',
  order_types: 'admin.order_types',
  payment_types: 'admin.payment_types',
  extras: 'admin.extras',
  taxes: 'admin.taxes',
  users: 'admin.users',
  security_alerts: 'admin.security_alerts',
  catalog_publish: 'admin.catalog_publish',
};

/** Build-time module ids (VITE_APP_MODULES / _EXCLUDE). qr_ordering is independent of tables. */
const ADMIN_TAB_BUILD_MODULES: Record<AdminTabKey, string> = {
  ...ADMIN_TAB_MODULES,
  qr_ordering: 'admin.qr_ordering',
};

const ADMIN_TAB_PAGE_SIZE = 10;

export const Admin = () => {
  const [selected, setSelected] = useState<AdminTabKey>('dishes');
  const [page, setPage] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const {protectAction} = useSecurity();
  const { t } = useTranslation('admin');
  const { t: tNav } = useTranslation('navigation');

  const pages = useMemo(() => {
    const all = {
      dishes: { component: <AdminDishes/>, title: t('tabs.dishes') },
      menus: { component: <AdminMenus/>, title: t('tabs.menus') },
      categories: { component: <AdminCategories/>, title: t('tabs.categories') },
      modifier_groups: { component: <AdminModifierGroups/>, title: t('tabs.modifierGroups') },
      tables: { component: <AdminTables/>, title: t('tabs.tables') },
      qr_ordering: { component: <AdminSelfOrder/>, title: t('tabs.qrOrdering') },
      floors: { component: <AdminFloors/>, title: t('tabs.floors') },
      discounts: { component: <AdminDiscounts/>, title: t('tabs.discounts') },
      coupons: { component: <AdminCoupons/>, title: t('tabs.coupons') },
      kitchens: { component: <AdminKitchens/>, title: t('tabs.kitchens') },
      workflows: { component: <AdminWorkflows/>, title: t('tabs.workflows') },
      printers: { component: <AdminPrinters/>, title: t('tabs.printers') },
      print_settings: { component: <AdminPrints/>, title: t('tabs.printSettings') },
      order_types: { component: <AdminOrderTypes/>, title: t('tabs.orderTypes') },
      payment_types: { component: <AdminPaymentTypes/>, title: t('tabs.paymentTypes') },
      extras: { component: <AdminExtras/>, title: t('tabs.extras') },
      taxes: { component: <AdminTaxes/>, title: t('tabs.taxes') },
      users: { component: <AdminUsers/>, title: t('tabs.users') },
      security_alerts: { component: <SecurityAlertsPanel/>, title: t('tabs.securityAlerts') },
      catalog_publish: { component: <CatalogPublishPanel/>, title: t('tabs.catalogPublish') },
    };
    return filterPagesByBuildModule(all, ADMIN_TAB_BUILD_MODULES);
  }, [t]);

  const tabKeys = useMemo(
    () => (Object.keys(pages) as AdminTabKey[]).filter((key) => ADMIN_TAB_KEYS.includes(key)),
    [pages],
  );

  const selectedKey = (firstPageKey(pages, selected) || 'dishes') as AdminTabKey;

  const pageCount = Math.max(1, Math.ceil(tabKeys.length / ADMIN_TAB_PAGE_SIZE));

  // Build-module filtering can shrink the tab list; keep the page index in range.
  useEffect(() => {
    setPage((prev) => Math.min(prev, pageCount - 1));
  }, [pageCount]);

  const pageStart = page * ADMIN_TAB_PAGE_SIZE;
  const visibleTabKeys = tabKeys.slice(pageStart, pageStart + ADMIN_TAB_PAGE_SIZE);

  const goToPage = (next: number) => {
    setDirection(next > page ? 1 : -1);
    setPage(Math.min(Math.max(next, 0), pageCount - 1));
  };

  const arrowButtonClass = "flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface text-foreground cursor-pointer hover:bg-neutral-100 active:shadow-none disabled:opacity-40 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-primary-500";

  return (
    <Layout>
      <DocumentTitle parts={[pages[selectedKey]?.title, tNav('sidebar.manage')]} />
      <div data-testid="admin-page" className="h-full min-h-0 flex flex-col">
        <Tabs
          className="w-full flex flex-col flex-1 min-h-0"
          selectedKey={selectedKey}
          onSelectionChange={(key: string) => protectAction(() => setSelected(key as AdminTabKey), {
            module: ADMIN_TAB_MODULES[key as AdminTabKey],
            description: t('tabs.accessTab', { title: pages[key as AdminTabKey].title }),
          })}
        >
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
            {tabKeys.map((key) => (
              <TabPanel id={key} key={key} className="bg-surface-elevated shadow flex-grow flex-shrink-0">
                <div data-testid={`admin-panel-${key}`}>
                  {pages[key].component}
                </div>
              </TabPanel>
            ))}
          </div>
          <div
            data-testid="admin-tabs-bar"
            className="flex-shrink-0 border-t border-border bg-surface-elevated px-3 pt-2 pb-1 shadow-[0_-4px_12px_rgba(0,0,0,0.05)]"
          >
            <TabList
              key={page}
              aria-label={t('tabs.ariaLabel')}
              className={`flex flex-row items-stretch justify-center gap-2 w-full flex-nowrap [&>div]:min-w-0 [&>div]:flex-initial [&>div]:px-3 animate-in fade-in duration-200 motion-reduce:animate-none ${
                direction === 1 ? 'slide-in-from-right-4' : 'slide-in-from-left-4'
              }`}
              data-testid="admin-tabs"
            >
              {visibleTabKeys.map(key => (
                <Tab
                  id={key}
                  key={key}
                  data-testid={`admin-tab-${key}`}
                >
                  <span className="min-w-0 truncate" title={t(TAB_I18N_KEYS[key])}>
                    {t(TAB_I18N_KEYS[key])}
                  </span>
                </Tab>
              ))}
            </TabList>
            {pageCount > 1 && (
              <nav
                data-testid="admin-tabs-nav"
                aria-label={t('tabs.ariaLabel')}
                className="mt-1 flex items-center justify-center gap-3 py-1"
              >
                <button
                  type="button"
                  data-testid="admin-tabs-prev"
                  aria-label={t('tabs.prevGroup')}
                  disabled={page === 0}
                  onClick={() => goToPage(page - 1)}
                  className={arrowButtonClass}
                >
                  <FontAwesomeIcon icon={faChevronLeft} />
                </button>
                <button
                  type="button"
                  data-testid="admin-tabs-next"
                  aria-label={t('tabs.nextGroup')}
                  disabled={page === pageCount - 1}
                  onClick={() => goToPage(page + 1)}
                  className={arrowButtonClass}
                >
                  <FontAwesomeIcon icon={faChevronRight} />
                </button>
              </nav>
            )}
          </div>
        </Tabs>
      </div>
    </Layout>
  )
}
