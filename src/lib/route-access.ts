import type {User} from '@/api/model/user.ts';
import {
  ACCOUNTS,
  ADMIN,
  CLOCK,
  CLOSING,
  HR,
  INTEGRATIONS,
  INVENTORY,
  KITCHEN,
  MENU,
  ORDER_DISPLAY,
  ORDERS,
  REPORTS,
  SETTINGS,
  SUMMARY,
} from '@/routes/restaurant-manager.ts';
import {HOME_CANDIDATES} from '@/lib/build-modules.ts';
import {getUserModules, moduleMatchCandidates} from '@/lib/access.rules.ts';
import {hasModuleElevation} from '@/lib/module-elevation.ts';

/** Top-level route prefix → permission module id (mirrors the sidebar map). */
const ROUTE_MODULES: Array<[string, string]> = [
  [MENU, 'menu'],
  [ORDERS, 'orders'],
  [SUMMARY, 'summary'],
  [KITCHEN, 'kitchen'],
  [ORDER_DISPLAY, 'order_display'],
  [CLOSING, 'closing'],
  [INVENTORY, 'inventory'],
  [ADMIN, 'admin'],
  [REPORTS, 'reports'],
  [ACCOUNTS, 'accounts'],
  [HR, 'hr'],
  [INTEGRATIONS, 'integrations'],
  [SETTINGS, 'settings'],
];

/** Permission module the given pathname belongs to (null = no module gate, e.g. /clock). */
export const routeRequiredModule = (pathname: string): string | null => {
  const matches = ROUTE_MODULES
    .filter(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))
    .sort((a, b) => b[0].length - a[0].length);
  return matches[0]?.[1] ?? null;
};

/** True when the user's role modules (or a fresh manager PIN unlock) cover the module. */
export const canAccessModule = (user: User | undefined, module?: string | null): boolean => {
  if (!module) return true;
  if (hasModuleElevation(module)) return true;
  const userModules = getUserModules(user);
  return moduleMatchCandidates(module).some((candidate) => userModules.includes(candidate));
};

/** First post-login path the user may actually open — role-aware fallback for
 *  redirects, so an unauthorized route never bounces into another guarded one. */
export const getAllowedAppPath = (user?: User): string => {
  for (const candidate of HOME_CANDIDATES) {
    if (canAccessModule(user, candidate.module)) return candidate.path;
  }
  return CLOCK;
};
