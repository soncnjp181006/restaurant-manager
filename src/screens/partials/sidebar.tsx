import { useAtom } from "jotai";
import { appPage } from "@/store/jotai.ts";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBars,
  faClipboardList,
  faGear, faLineChart,
  faDisplay,
  faList, faLock,
  faStore,
  faUtensils, faUsers, faWarehouse, faWrench,
  faClock,
  faPowerOff,
  faReceipt,
  faUser,
  faPlug
} from "@fortawesome/free-solid-svg-icons";
import { cn } from "@/lib/utils.ts";
import { IconTooltipButton } from "@/components/common/input/icon.tooltip.button.tsx";
import { CSSProperties, useMemo } from "react";
import {NavLink, useNavigate} from "react-router";
import {
  ADMIN,
  CLOSING,
  CLOCK,
  INVENTORY,
  HR,
  KITCHEN,
  ORDER_DISPLAY,
  MENU,
  ORDERS,
  REPORTS,
  SETTINGS,
  INTEGRATIONS,
  SUMMARY,
  ACCOUNTS
} from "@/routes/restaurant-manager.ts";
import { getAccessRuleChildLabel } from "@/lib/access.rules.i18n.ts";
import { getUserModules, moduleMatchCandidates } from "@/lib/access.rules.ts";
import { filterByBuildModule, isBuildModuleEnabled } from "@/lib/build-modules.ts";
import { useSecurity } from "@/hooks/useSecurity.ts";
import { useTranslation } from "react-i18next";
import { lockSession, logoutSession } from "@/lib/session.actions.ts";
import { SecurityAlertsBadge } from "@/components/admin/security-alerts/alert-badge.tsx";

const SIDEBAR_NAV_TEST_IDS: Partial<Record<string, string>> = {
  [MENU]: 'nav-menu',
  [ORDERS]: 'nav-orders',
  [SUMMARY]: 'nav-summary',
  [KITCHEN]: 'nav-kitchen',
  [ORDER_DISPLAY]: 'nav-order-display',
  [CLOSING]: 'nav-closing',
  [INVENTORY]: 'nav-inventory',
  [ADMIN]: 'nav-admin',
  [REPORTS]: 'nav-reports',
  [ACCOUNTS]: 'nav-accounts',
  [HR]: 'nav-hr',
  [INTEGRATIONS]: 'nav-integrations',
};

/**
 * Navigation is grouped by what staff are doing, not by database table:
 * selling, running the shift, and administering the business. Groups keep
 * twelve sections scannable without turning the rail into a flat list.
 */
const GROUP_OF: Record<string, 'sales' | 'operations' | 'admin'> = {
  menu: 'sales',
  orders: 'sales',
  summary: 'sales',
  kitchen: 'sales',
  order_display: 'sales',
  closing: 'operations',
  inventory: 'operations',
  reports: 'operations',
  accounts: 'operations',
  hr: 'admin',
  admin: 'admin',
  integrations: 'admin',
};

export const Sidebar = () => {
  const [page, setPage] = useAtom(appPage);
  const { t } = useTranslation(['navigation', 'common']);

  const pathInfo = location.pathname;

  const navigation = useNavigate();
  const { protectAction } = useSecurity();

  const logout = () => {
    void logoutSession(setPage, navigation);
  }

  const protectedNavigate = async (to: string, module?: string, description?: string) => {
    await protectAction(() => navigation(to), {
      description: description || t('authenticateToAccess', { module }),
      module,
    });
  }

  const lock = () => {
    void protectAction(() => lockSession(setPage, navigation), {
      description: getAccessRuleChildLabel('settings.access_control'),
      module: 'settings.access_control',
    });
  }

  const allSidebarItems = useMemo(() => [
    { title: t('sidebar.menu'), icon: <FontAwesomeIcon icon={faBars}/>, link: MENU, role: 'menu' },
    { title: t('sidebar.orders'), icon: <FontAwesomeIcon icon={faList}/>, link: ORDERS, role: 'orders' },
    { title: t('sidebar.summary'), icon: <FontAwesomeIcon icon={faClipboardList}/>, link: SUMMARY, role: 'summary' },
    { title: t('sidebar.kitchen'), icon: <FontAwesomeIcon icon={faUtensils}/>, link: KITCHEN, role: 'kitchen' },
    { title: t('sidebar.orderDisplay'), icon: <FontAwesomeIcon icon={faDisplay}/>, link: ORDER_DISPLAY, role: 'order_display' },
    { title: t('sidebar.closing'), icon: <FontAwesomeIcon icon={faStore}/>, link: CLOSING, role: 'closing' },
    { title: t('sidebar.inventory'), icon: <FontAwesomeIcon icon={faWarehouse}/>, link: INVENTORY, role: 'inventory' },
    { title: t('sidebar.reports'), icon: <FontAwesomeIcon icon={faLineChart}/>, link: REPORTS, role: 'reports' },
    { title: t('sidebar.accounts'), icon: <FontAwesomeIcon icon={faReceipt}/>, link: ACCOUNTS, role: 'accounts' },
    { title: t('sidebar.hr'), icon: <FontAwesomeIcon icon={faUsers}/>, link: HR, role: 'hr' },
    { title: t('sidebar.manage'), icon: <FontAwesomeIcon icon={faGear}/>, link: ADMIN, role: 'admin' },
    { title: t('sidebar.integrations'), icon: <FontAwesomeIcon icon={faPlug}/>, link: INTEGRATIONS, role: 'integrations' },
  ], [t]);

  // Every section stays visible and tappable to everyone — the actual gate
  // is protectedNavigate's PIN prompt on click. hasModuleAccess is display
  // only: it dims sections the current user can't open directly, so people
  // aren't surprised by a PIN prompt on something that looked just as
  // available as everything else.
  const userRoles = getUserModules(page.user);
  const hasModuleAccess = (moduleId?: string) => {
    if (!moduleId) return true;
    return moduleMatchCandidates(moduleId).some((candidate) => userRoles.includes(candidate));
  };
  const sidebarItems = useMemo(
    () => filterByBuildModule(allSidebarItems, (item) => item.role),
    [allSidebarItems],
  );
  const showSettings = isBuildModuleEnabled('settings');

  const groups = useMemo(() => {
    const order: Array<'sales' | 'operations' | 'admin'> = ['sales', 'operations', 'admin'];
    return order
      .map((id) => ({
        id,
        label: t(`groups.${id}`, { defaultValue: id }),
        items: sidebarItems.filter((item) => GROUP_OF[item.role ?? ''] === id),
      }))
      .filter((group) => group.items.length > 0);
  }, [sidebarItems, t]);

  const userName = [page.user?.first_name, page.user?.last_name].filter(Boolean).join(' ') || page.user?.login || '';
  const restaurantName = import.meta.env.VITE_RESTAURANT_NAME || 'POS';
  const initials = (page.user?.first_name?.[0] ?? page.user?.login?.[0] ?? 'N').toUpperCase();

  return (
    <aside className="app-sidebar" data-testid="app-sidebar">
      <div className="sidebar-brand">
        <span
          aria-hidden="true"
          className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg bg-foreground text-[13px] font-semibold text-canvas"
        >
          {(restaurantName || 'P').trim().charAt(0).toUpperCase()}
        </span>
        <div className="sidebar-brand-text min-w-0">
          <div className="truncate text-[14px] font-semibold leading-tight">{restaurantName}</div>
          <div className="truncate text-[11.5px] leading-tight text-muted">{userName}</div>
        </div>
      </div>

      <div className="sidebar-scroll">
        {groups.map((group) => (
          <div className="nav-group" key={group.id} role="group" aria-label={group.label}>
            <p className="nav-group-label">{group.label}</p>
            {group.items.map((item) => {
              const accessible = hasModuleAccess(item.role);
              const isActive = pathInfo === item.link;
              return (
                <button
                  type="button"
                  aria-current={isActive ? 'page' : undefined}
                  data-testid={SIDEBAR_NAV_TEST_IDS[item.link] ?? undefined}
                  title={accessible ? item.title : t('sidebar.requiresApproval', {
                    defaultValue: 'Requires manager approval',
                  })}
                  onClick={() => {
                    protectedNavigate(item.link, item.role);
                  }}
                  className="nav-item"
                  key={item.title}
                >
                  <span className={cn('nav-icon', !accessible && 'opacity-40')}>{item.icon}</span>
                  <span className="nav-label flex-1 truncate">{item.title}</span>
                  {!accessible && (
                    <span className="nav-label flex h-4 w-4 items-center justify-center rounded-full text-[9px] text-muted">
                      <FontAwesomeIcon icon={faLock} />
                    </span>
                  )}
                  {item.link === ADMIN && <SecurityAlertsBadge />}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="sidebar-footer">
        <div className="flex flex-col gap-0.5">
          {showSettings ? (
            <button
              type="button"
              data-testid="nav-settings"
              aria-label={t('sidebar.settings')}
              title={t('sidebar.settings')}
              aria-current={pathInfo === SETTINGS ? 'page' : undefined}
              onClick={() => protectedNavigate(SETTINGS, 'settings')}
              className="nav-item"
            >
              <span className="nav-icon"><FontAwesomeIcon icon={faWrench} /></span>
              <span className="nav-label flex-1 truncate">{t('sidebar.settings')}</span>
            </button>
          ) : null}
          <NavLink
            to={CLOCK}
            data-testid="nav-clock"
            aria-label={t('sidebar.clock')}
            title={t('sidebar.clock')}
            className="nav-item"
          >
            <span className="nav-icon"><FontAwesomeIcon icon={faClock} /></span>
            <span className="nav-label flex-1 truncate">{t('sidebar.clock')}</span>
          </NavLink>
        </div>

        <div className="mt-2 flex items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-surface-elevated px-2 py-1.5">
            <span className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-primary/12 text-[12px] font-semibold text-primary">
              {initials}
            </span>
            <span className="nav-label min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium leading-tight">{userName}</span>
              <span className="block truncate text-[11px] leading-tight text-muted">{page.user?.login}</span>
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <IconTooltipButton
              label={t('common:actions.lock')}
              variant="primary"
              onClick={lock}
              size="sm"
              className="!h-7 !w-7"
              data-testid="nav-lock"
            >
              <FontAwesomeIcon icon={faLock} className="text-[11px]" />
            </IconTooltipButton>
            <IconTooltipButton
              label={t('common:actions.logout')}
              variant="danger"
              onClick={logout}
              size="sm"
              className="!h-7 !w-7"
              data-testid="nav-logout"
            >
              <FontAwesomeIcon icon={faPowerOff} className="text-[11px]" />
            </IconTooltipButton>
          </div>
        </div>
      </div>
    </aside>
  )
}
