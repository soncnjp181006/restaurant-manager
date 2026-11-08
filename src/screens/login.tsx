import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBackspace, faClock } from "@fortawesome/free-solid-svg-icons";
import {useEffect, useLayoutEffect, useState} from "react";
import { useAtom } from "jotai";
import { appPage } from "@/store/jotai.ts";
import { cn, toRecordId } from "@/lib/utils.ts";
import { DbNotReadyError, useDB } from "@/api/db/db.ts";
import { useDatabase } from "@/hooks/useDatabase.ts";
import { User } from "@/api/model/user.ts";
import {useNavigate, useLocation} from "react-router";
import {getDefaultAppPath} from "@/lib/build-modules.ts";
import {canAccessModule, getAllowedAppPath, routeRequiredModule} from "@/lib/route-access.ts";
import { Modal } from "@/components/common/react-aria/modal.tsx";
import { Button } from "@/components/common/input/button.tsx";
import { Tables } from "@/api/db/tables.ts";
import { toast } from "sonner";
import { getUserModules } from "@/lib/access.rules.ts";
import { UserRole } from "@/api/model/user_role.ts";
import { Input } from "@/components/common/input/input.tsx";
import { clockIn as laborClockIn } from "@/lib/labor-engine/attendance/attendance.service.ts";
import { ensureEmployeeForUser } from "@/lib/labor-engine/employee.resolver.ts";
import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n.ts";
import { DocumentTitle } from "@/components/common/document-title.tsx";
import { PageLoader } from "@/components/common/loader/page-loader.tsx";
import {
  clearSessionTokens,
  fetchAuthStatus,
  gatewayBootstrapAdmin,
  gatewayLogin,
  getSessionToken,
  isGatewayAuthEnabled,
  setSessionTokens,
  type GatewayLoginResponse,
} from "@/lib/session.ts";
import { fetchLoginBrandLogo } from "@/lib/branding.ts";
import { AdminSetupWizard } from "@/components/auth/admin-setup.wizard";

const TIME_ENTRY_CHECK_RETRIES = 3;
const TIME_ENTRY_RETRY_DELAY_MS = 400;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MINUTES = 15;

type LoginMethod = 'pin' | 'form';

/** Default login tab from VITE_DEFAULT_LOGIN_METHOD (`pin` | `form`). Falls back to pin. */
const getDefaultLoginMethod = (): LoginMethod => {
  const raw = String(import.meta.env.VITE_DEFAULT_LOGIN_METHOD ?? 'pin').toLowerCase().trim();
  return raw === 'form' ? 'form' : 'pin';
};

const sleep = (ms: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, ms);
});

const formatRetryMinutes = (retryAfterMs?: number, lockoutMs?: number) => {
  const ms = retryAfterMs ?? lockoutMs ?? LOGIN_LOCKOUT_MINUTES * 60 * 1000;
  return Math.max(1, Math.ceil(ms / 60000));
};

export const Login = () => {
  const db = useDB();
  const { connect } = useDatabase();
  const { t } = useTranslation('auth');
  const { t: tCommon } = useTranslation('common');
  const gatewayAuth = isGatewayAuthEnabled();

  const [code, setCode] = useState('');
  const [loginMethod, setLoginMethod] = useState<LoginMethod>(getDefaultLoginMethod);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [page, setPage] = useAtom(appPage);
  const [error, setError] = useState(false);
  const [showClockInModal, setShowClockInModal] = useState(false);
  const [pendingUser, setPendingUser] = useState<User | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [brandLogo, setBrandLogo] = useState<string | null>(null);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [bootstrapMode, setBootstrapMode] = useState(false);
  /** Bootstrap admin just created and waiting on the clock-in gate. */
  const [pendingFromBootstrap, setPendingFromBootstrap] = useState(false);

  const navigation = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    void fetchLoginBrandLogo(gatewayAuth ? null : db).then((logo) => {
      if (!cancelled) setBrandLogo(logo);
    });
    return () => {
      cancelled = true;
    };
  }, [gatewayAuth]);

  // First-run detection: when no user exists the gateway only accepts PIN
  // 0000 and the app forces creating the admin account.
  useEffect(() => {
    if (!gatewayAuth) return;
    let cancelled = false;
    void fetchAuthStatus().then((status) => {
      if (!cancelled && status.needsBootstrap) setNeedsBootstrap(true);
    });
    return () => {
      cancelled = true;
    };
  }, [gatewayAuth]);

  const onClear = () => {
    setCode('');
  }

  const onBack = () => {
    setCode(prev => prev.slice(0, prev.length - 1));
  }

  const onKey = (key: string) => {
    // Functional update so two keystrokes in the same tick can't both read a
    // stale `code` and drop one of the digits.
    setCode(prev => (prev.trim().length <= 3 ? prev + key : prev));
  }

  // The PIN pad only ever had onClick handlers on its visible buttons — a
  // physical keyboard's digit keys did nothing. Mirror the same digits,
  // Backspace, and Escape/Delete (clear) while the PIN method is active.
  useEffect(() => {
    if (loginMethod !== 'pin') return;

    const onPhysicalKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (event.key >= '0' && event.key <= '9') {
        event.preventDefault();
        onKey(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        onBack();
      } else if (event.key === 'Escape' || event.key === 'Delete') {
        event.preventDefault();
        onClear();
      }
    };

    window.addEventListener('keydown', onPhysicalKeyDown);
    return () => window.removeEventListener('keydown', onPhysicalKeyDown);
  }, [loginMethod, code]);

  const failConnection = () => {
    clearSessionTokens();
    toast.error(i18n.t('auth:login.connectionFailed', { defaultValue: 'Database connection failed after login' }));
    denyLogin();
  };

  const afterUserAuthenticated = async (normalizedUser: User) => {
    if (page.locked && page.lockedBy?.login !== normalizedUser.login) {
      denyLogin();
      return false;
    }

    for (let attempt = 0; attempt < TIME_ENTRY_CHECK_RETRIES; attempt++) {
      try {
        const timeEntryCheck = await db.query(
          `SELECT * from ${Tables.time_entries} where user = $userId and clock_out = NONE and platform = $platform`,
          {
            userId: toRecordId(normalizedUser.id),
            platform: 'web',
          }
        );

        const rows = timeEntryCheck?.[0];
        if (!Array.isArray(rows)) {
          throw new Error('Unexpected time entry query result');
        }

        if (rows.length === 0) {
          setPendingUser(normalizedUser);
          setShowClockInModal(true);
        } else {
          allowLogin(normalizedUser);
        }
        return true;
      } catch (err) {
        const errName = err instanceof Error ? err.name : '';
        const isNotReady =
          err instanceof DbNotReadyError ||
          errName === 'ConnectionUnavailable' ||
          errName === 'EngineDisconnected';
        console.error(err);

        if (attempt < TIME_ENTRY_CHECK_RETRIES - 1 && isNotReady) {
          try {
            await connect();
          } catch (connectErr) {
            console.error(connectErr);
          }
          await sleep(TIME_ENTRY_RETRY_DELAY_MS);
          continue;
        }

        if (gatewayAuth) {
          failConnection();
        } else {
          toast.error(i18n.t('auth:login.connectionFailed', { defaultValue: 'Database connection failed after login' }));
          denyLogin();
        }
        return false;
      }
    }

    return false;
  };

  const getLockoutPolicyMessage = () => t('login.lockoutPolicy', {
    maxAttempts: LOGIN_MAX_ATTEMPTS,
    lockoutMinutes: LOGIN_LOCKOUT_MINUTES,
    defaultValue: `After ${LOGIN_MAX_ATTEMPTS} failed attempts, your account will be locked for ${LOGIN_LOCKOUT_MINUTES} minutes.`,
  });

  const showLoginFailureToast = (result?: GatewayLoginResponse) => {
    if (result?.status === 429 || result?.retryAfterMs != null) {
      const minutes = formatRetryMinutes(result.retryAfterMs, result.lockoutMs);
      const message = result.code === 'rate_limited_ip'
        ? t('login.rateLimitedIp', { minutes, defaultValue: `Too many login attempts. Try again in ${minutes} minute(s).` })
        : t('login.rateLimited', { minutes, defaultValue: `Too many login attempts. Try again in ${minutes} minute(s).` });
      toast.error(message);
      return;
    }

    const lockoutPolicy = gatewayAuth ? getLockoutPolicyMessage() : undefined;

    if (result?.attemptsRemaining != null && result.attemptsRemaining > 0) {
      toast.error(t('login.invalidCredentialsWithAttempts', {
        count: result.attemptsRemaining,
        defaultValue: `Invalid username or password. ${result.attemptsRemaining} attempt(s) remaining before lockout.`,
      }), { description: lockoutPolicy });
      return;
    }

    toast.error(t('login.invalidCredentials'), { description: lockoutPolicy });
  };

  const handleLoginFailure = (result?: GatewayLoginResponse) => {
    showLoginFailureToast(result);
    denyLogin();
  };

  const checkLoginGateway = async (login: string, pass: string, method: 'pin'|'form') => {
    const result = await gatewayLogin({ method, login, password: pass });
    if (!result.ok || !result.token || !result.surrealToken || !result.user) {
      handleLoginFailure(result);
      return false;
    }

    setSessionTokens(result.token, result.surrealToken);

    try {
      // Connect before announcing the session so Login stays mounted.
      await connect();
    } catch (err) {
      console.error(err);
      failConnection();
      return false;
    }

    // First-run bootstrap session: hold the app on the admin-setup wizard
    // instead of entering (the bootstrap identity has no real account yet).
    if ((result.user as { bootstrap?: boolean } | undefined)?.bootstrap === true) {
      setBootstrapMode(true);
      return true;
    }

    const loggedInUser = result.user as User;
    const normalizedUser = {
      ...loggedInUser,
      roles: (loggedInUser as User & { roles?: string[] }).roles?.length
        ? (loggedInUser as User & { roles?: string[] }).roles!
        : getUserModules(loggedInUser),
    } as User;

    // Finish clock-in status check while Login is still mounted (session not announced yet).
    const ok = await afterUserAuthenticated(normalizedUser);
    // Sync provider with token presence (cleared on connection failure).
    window.dispatchEvent(new Event('restaurant-manager-session'));
    return ok;
  };

  const checkLoginLegacy = async (login: string, pass: string, method: 'pin'|'form') => {
    const query = method === 'pin'
      ? `SELECT * from ${Tables.users} where login = $login and deleted_at = none and (login_method = 'pin' OR login_method = NONE) and crypto::bcrypt::compare(password, $password) = true fetch user_role, user_shift`
      : `SELECT * from ${Tables.users} where login = $login and deleted_at = none and login_method = 'form' and crypto::bcrypt::compare(password, $password) = true fetch user_role, user_shift`;

    const record: any = await db.query(query, {
      login: login,
      password: pass,
    });

    if (record[0].length > 0) {
      const loggedInUser = record[0][0];
      const roleId = typeof loggedInUser.user_role === "object" ? loggedInUser.user_role?.id : loggedInUser.user_role;
      let fetchedRole: UserRole | undefined;

      if (roleId) {
        const [roleRecords]: any = await db.query(`SELECT * FROM ${Tables.user_roles} WHERE id = $roleId AND deleted_at = none LIMIT 1`, {
          roleId,
        });
        fetchedRole = roleRecords?.[0];
      }

      const normalizedUser = {
        ...loggedInUser,
        user_role: fetchedRole || loggedInUser.user_role,
        roles: fetchedRole
          ? [...new Set(fetchedRole.roles || [])]
          : getUserModules(loggedInUser),
      };

      return afterUserAuthenticated(normalizedUser);
    }

    showLoginFailureToast();
    denyLogin();
    return false;
  };

  const checkLogin = async (login: string, pass: string, method: 'pin'|'form') => {
    if ((method === 'pin' && login.trim().length === 4) || (method === 'form' && login.trim() && pass.trim())) {
      setIsAuthenticating(true);
      try {
        if (gatewayAuth) {
          return await checkLoginGateway(login, pass, method);
        }
        return await checkLoginLegacy(login, pass, method);
      } catch (err) {
        console.error(err);
        denyLogin();
        return false;
      } finally {
        setIsAuthenticating(false);
      }
    }
  }

  const allowLogin = (user: User) => {
    setPage(prev => ({
      ...prev,
      page: 'Menu',
      locked: false,
      lockedBy: undefined,
      user: user
    }));

    setCode('');
    setUsername('');
    setPassword('');
    setShowClockInModal(false);
    setPendingUser(null);
    // Bootstrap flow keeps the admin wizard mounted behind the clock-in gate —
    // unmount it only now that the gate has been passed.
    setBootstrapMode(false);
    setPendingFromBootstrap(false);

    navigation(getDefaultAppPath());
  }

  const handleClockIn = async () => {
    if(!pendingUser) return;

    try {
      const employee = await ensureEmployeeForUser(db, pendingUser);
      await laborClockIn(db, {
        user: pendingUser,
        employeeId: employee.id,
        platform: 'web',
        shiftTemplateId: pendingUser.user_shift?.id,
      });

      toast.success(i18n.t('auth:clockIn.success'));
      allowLogin(pendingUser);
    } catch (error) {
      toast.error(i18n.t('auth:clockIn.failed'));
      console.error(error);
    }
  }

  const denyLogin = () => {
    setCode('');
    setPassword('');
    setError(true);
  }

  useEffect(() => {
    if (loginMethod === 'pin') {
      void checkLogin(code, code, 'pin').catch((err) => {
        console.error(err);
        setIsAuthenticating(false);
        denyLogin();
      });
    }
  }, [code]);

  useEffect(() => {
    if(error){
      setTimeout(() => setError(false), 400);
    }
  }, [error]);

  useLayoutEffect(() => {
    // Gateway mode: user may exist in localStorage from another tab without a JWT here —
    // do not bounce back to the protected route or we loop Login ↔ report forever.
    if (gatewayAuth && !getSessionToken()) {
      return;
    }
    if (page.user && !page.locked) {
      const from = (location.state as { from?: { pathname: string; search?: string } })?.from;
      // Only restore the pre-login route when the user is actually allowed
      // there — a Staff user must not be dropped into the last Admin page.
      const fromAccessible = from ? canAccessModule(page.user, routeRequiredModule(from.pathname)) : false;
      const returnPath = from && fromAccessible
        ? `${from.pathname}${from.search ?? ''}`
        : getAllowedAppPath(page.user);
      navigation(returnPath, { replace: true });
    }
  }, [gatewayAuth, page.user, page.locked, location.state, navigation]);

  const clockInModal = showClockInModal ? (
    <Modal
      open={showClockInModal}
      onClose={() => {
        setShowClockInModal(false);
        setPendingUser(null);
        setCode('');
        // Bootstrap gate dismissed: fall back to the normal login pad.
        if (pendingFromBootstrap) {
          setBootstrapMode(false);
          setPendingFromBootstrap(false);
        }
      }}
      title={t('clockIn.title')}
      shouldCloseOnOverlayClick={false}
      shouldCloseOnEsc={false}
    >
      <div className="flex flex-col gap-4 items-center">
        <div className="text-lg alert alert-danger">
          {t('clockIn.message')}
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={handleClockIn}
            icon={faClock}
            size="xl"
            data-testid="login-clock-in"
          >
            {t('clockIn.action')}
          </Button>
        </div>
      </div>
    </Modal>
  ) : null;

  if (isAuthenticating) {
    return (
      <>
        <DocumentTitle parts={[t('login.title')]} />
        <PageLoader message={tCommon('database.connecting')} />
      </>
    );
  }

  if (bootstrapMode) {
    return (
      <>
        <AdminSetupWizard
        onCompleted={async (result) => {
          // Real admin session — proceed exactly like a normal login.
          setSessionTokens(result.token!, result.surrealToken!);
          try {
            await connect();
          } catch (err) {
            console.error(err);
            failConnection();
            setBootstrapMode(false);
            return;
          }
          const loggedInUser = result.user as User;
          const normalizedUser = {
            ...loggedInUser,
            roles: (loggedInUser as User & { roles?: string[] }).roles?.length
              ? (loggedInUser as User & { roles?: string[] }).roles!
              : getUserModules(loggedInUser),
          } as User;
          await afterUserAuthenticated(normalizedUser);
          window.dispatchEvent(new Event('restaurant-manager-session'));
          setNeedsBootstrap(false);
          // Keep the wizard mounted while the clock-in gate is up: flipping to
          // the login pad here used to stack the gate on top of the login screen.
          setPendingFromBootstrap(true);
        }}
        />
        {clockInModal}
      </>
    );
  }

  return (
    <div className="login-shell" data-testid="login-page">
      <DocumentTitle parts={[t('login.title')]} />

      <aside className="login-brand" data-testid="login-branding-panel">
        <div className="relative z-10 flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="grid h-8 w-8 place-items-center rounded-lg bg-foreground text-[13px] font-semibold text-canvas"
          >
            {(import.meta.env.VITE_RESTAURANT_NAME || 'P').trim().charAt(0).toUpperCase()}
          </span>
          <span className="text-[13.5px] font-semibold tracking-[-0.01em]">
            {import.meta.env.VITE_RESTAURANT_NAME || 'POS'}
          </span>
        </div>

        <div className="relative z-10 max-w-[460px]">
          {brandLogo ? (
            <img
              src={brandLogo}
              alt={t('login.brandLogoAlt')}
              className="mb-10 max-h-24 max-w-[240px] object-contain"
              data-testid="login-brand-logo"
            />
          ) : (
            <div
              role="img"
              aria-label={t('login.brandLogoAlt')}
              className="mb-10 grid h-24 w-24 place-items-center rounded-2xl bg-primary text-[40px] font-semibold leading-none text-primary-fg"
              data-testid="login-brand-logo"
            >
              {(import.meta.env.VITE_RESTAURANT_NAME || 'P').trim().charAt(0).toUpperCase()}
            </div>
          )}

          <h1 className="text-[38px] font-semibold leading-[1.08] tracking-[-0.03em]">
            {import.meta.env.VITE_RESTAURANT_NAME || t('login.brandTitle', { defaultValue: 'Start your shift' })}
          </h1>
          <p className="mt-3 max-w-[38ch] text-[14px] leading-relaxed text-muted">
            {t('login.brandTagline', {
              defaultValue: 'Order taking, the floor and the day’s numbers in one place.',
            })}
          </p>
        </div>

      </aside>

      <div className="login-form-column">
        <div className="login-card">
          <div>
            <h2 className="text-[23px] font-semibold leading-tight tracking-[-0.02em]">
              {t('login.title')}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              {loginMethod === 'pin'
                ? t('login.pinHint', { defaultValue: 'Enter your 4-digit PIN to start.' })
                : t('login.formHint', { defaultValue: 'Sign in with your username and password.' })}
            </p>
          </div>

          <div
            className="flex rounded-[10px] border border-border bg-surface p-0.5"
            data-testid="login-method-switcher"
          >
            {(['pin', 'form'] as const).map((m) => (
              <button
                key={m}
                type="button"
                data-testid={m === 'pin' ? 'login-method-pin' : 'login-method-form'}
                aria-pressed={loginMethod === m}
                data-active={loginMethod === m}
                className="segment flex-1"
                onClick={() => {
                  setLoginMethod(m);
                  setError(false);
                  setUsername('');
                  setPassword('');
                  setCode('');
                }}
              >
                {m === 'pin' ? t('login.pin') : t('login.form')}
              </button>
            ))}
          </div>

          {needsBootstrap && (
            <p
              className="rounded-lg border border-info/25 bg-info/8 px-3 py-2 text-[12px] leading-relaxed"
              data-testid="login-bootstrap-hint"
            >
              {t('login.bootstrapHint', {
                defaultValue: 'First-time setup? Sign in with PIN 0000 to create the admin account.',
              })}
            </p>
          )}

          {page.locked && (
            <div
              className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-[12px] leading-relaxed"
              data-testid="login-locked-banner"
            >
              {t('login.systemLocked', {
                name: `${page?.lockedBy?.first_name ?? ''} ${page?.lockedBy?.last_name ?? ''}`.trim()
              })}
            </div>
          )}

          {loginMethod === 'pin' && (
            <>
              <div
                className={cn('pin-dots', error && 'login-error')}
                aria-hidden="true"
              >
                {[0, 1, 2, 3].map((idx) => (
                  <span
                    key={idx}
                    className="pin-dot"
                    data-filled={code.trim().length > idx}
                  />
                ))}
              </div>

              <div data-testid="login-pin-pad">
                <div className="keypad">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                    <button
                      key={digit}
                      type="button"
                      onClick={() => onKey(digit)}
                      className="login-key"
                    >
                      {digit}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={onBack}
                    className="login-key !text-[17px]"
                    aria-label={tCommon('actions.back')}
                  >
                    <FontAwesomeIcon icon={faBackspace} />
                  </button>
                  <button type="button" onClick={() => onKey('0')} className="login-key">0</button>
                  <button
                    type="button"
                    onClick={onClear}
                    className="login-key danger !text-[17px]"
                    aria-label={tCommon('actions.clear')}
                  >
                    C
                  </button>
                </div>
              </div>
            </>
          )}

          {loginMethod === 'form' && (
            <form
              className="flex flex-col gap-3"
              data-testid="login-form"
              onSubmit={async (event) => {
                event.preventDefault();
                await checkLogin(username, password, 'form');
              }}
            >
              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="username">
                  {t('login.username')}
                </label>
                <Input
                  id="username"
                  data-testid="login-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="password">
                  {t('login.password')}
                </label>
                <Input
                  id="password"
                  data-testid="login-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <Button type="submit" variant="primary" filled className="mt-1 w-full" size="lg" data-testid="login-submit">
                {t('login.submit')}
              </Button>
            </form>
          )}
        </div>
      </div>

      {clockInModal}
    </div>
  );

}
