import {useAtomValue, useSetAtom} from "jotai";
import {Navigate, Outlet, useLocation} from "react-router";
import {useEffect, useMemo, useState} from "react";
import {appPage} from "@/store/jotai.ts";
import {LOGIN} from "@/routes/restaurant-manager.ts";
import {clearSessionTokens, fetchAuthStatus, getSessionToken, isGatewayAuthEnabled} from "@/lib/session.ts";
import {useHydrateCurrencySymbol} from "@/hooks/useCurrencySymbol.ts";
import {canAccessModule, getAllowedAppPath, routeRequiredModule} from "@/lib/route-access.ts";

export const ProtectedRoute = () => {
  const {user} = useAtomValue(appPage);
  const setPage = useSetAtom(appPage);
  const location = useLocation();
  const [sessionTick, setSessionTick] = useState(0);
  useHydrateCurrencySymbol();

  useEffect(() => {
    const onSession = () => setSessionTick((tick) => tick + 1);
    window.addEventListener('restaurant-manager-session', onSession);
    return () => window.removeEventListener('restaurant-manager-session', onSession);
  }, []);

  useEffect(() => {
    if (!isGatewayAuthEnabled()) return;
    if (getSessionToken()) return;
    if (!user) return;
    setPage((prev) => ({
      ...prev,
      page: 'Login',
      user: undefined,
      locked: false,
      lockedBy: undefined,
    }));
  }, [sessionTick, user, setPage]);

  // First-run guard: if the server reports the user table is empty (bootstrap
  // mode), any stale local session is invalid — drop it and land on the
  // admin-setup wizard via the login screen.
  useEffect(() => {
    if (!isGatewayAuthEnabled()) return;
    if (!getSessionToken() && !user) return;
    let cancelled = false;
    void fetchAuthStatus().then((status) => {
      if (cancelled || !status.needsBootstrap) return;
      clearSessionTokens();
      setPage((prev) => ({
        ...prev,
        page: 'Login',
        user: undefined,
        locked: false,
        lockedBy: undefined,
      }));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionTick, user, setPage]);

  if (!user) {
    return <Navigate to={LOGIN} replace state={{from: location}}/>;
  }

  // sessionTick forces re-read of localStorage after restaurant-manager-session.
  void sessionTick;
  if (isGatewayAuthEnabled() && !getSessionToken()) {
    return <Navigate to={LOGIN} replace state={{from: location}}/>;
  }

  // Route-level permission guard: the sidebar's PIN prompt is click-time only —
  // without this check any authenticated user could land on a protected URL
  // (e.g. a Staff user restoring /settings from the previous session) and use it.
  const requiredModule = routeRequiredModule(location.pathname);
  const moduleAllowed = useMemo(
    () => canAccessModule(user, requiredModule),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.id, user?.user_role?.id, requiredModule, sessionTick],
  );
  if (!moduleAllowed) {
    return <Navigate to={getAllowedAppPath(user)} replace/>;
  }

  return (
    <Outlet/>
  );
};
