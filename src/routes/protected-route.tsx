import {useAtomValue, useSetAtom} from "jotai";
import {Navigate, Outlet, useLocation} from "react-router";
import {useEffect, useState} from "react";
import {appPage} from "@/store/jotai.ts";
import {LOGIN} from "@/routes/restaurant-manager.ts";
import {WhatsNewDialog} from "@/components/whats-new/whats-new.dialog.tsx";
import {getSessionToken, isGatewayAuthEnabled} from "@/lib/session.ts";
import {useHydrateCurrencySymbol} from "@/hooks/useCurrencySymbol.ts";

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

  if (!user) {
    return <Navigate to={LOGIN} replace state={{from: location}}/>;
  }

  // sessionTick forces re-read of localStorage after restaurant-manager-session.
  void sessionTick;
  if (isGatewayAuthEnabled() && !getSessionToken()) {
    return <Navigate to={LOGIN} replace state={{from: location}}/>;
  }

  return (
    <>
      <Outlet/>
      <WhatsNewDialog/>
    </>
  );
};
