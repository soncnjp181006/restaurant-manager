import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DocumentTitle } from '@/components/common/document-title';
import { LoginAurora } from '@/screens/login-aurora';
import { gatewayBootstrapAdmin, type GatewayLoginResponse } from '@/lib/session';
import { cn } from '@/lib/utils';

type Props = {
  /** Called with the real gateway session once the admin exists. */
  onCompleted: (result: GatewayLoginResponse) => void | Promise<void>;
};

const PIN_PATTERN = /^\d{4}$/;

/**
 * First-run gate: rendered instead of the whole app while the user table is
 * empty. Creating the admin is mandatory — there is no way past this screen
 * until the account exists (the server rejects the bootstrap once any user
 * exists, and a refresh simply lands back here).
 */
export const AdminSetupWizard = ({ onCompleted }: Props) => {
  const { t } = useTranslation('auth');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (submitting) return;
    const cleanName = name.trim();
    if (!cleanName) {
      setError(t('setup.nameRequired', { defaultValue: 'Admin name is required' }));
      return;
    }
    if (!PIN_PATTERN.test(pin)) {
      setError(t('setup.invalidPin', { defaultValue: 'PIN must be exactly 4 digits' }));
      return;
    }
    if (pin !== confirmPin) {
      setError(t('setup.mismatch', { defaultValue: 'PINs do not match' }));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await gatewayBootstrapAdmin({ name: cleanName, pin });
      if (!result.ok || !result.token || !result.surrealToken || !result.user) {
        setError(result.error || t('setup.failed', { defaultValue: 'Failed to create the admin account' }));
        return;
      }
      await onCompleted(result);
    } catch {
      setError(t('setup.failed', { defaultValue: 'Failed to create the admin account' }));
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-border bg-surface px-4 py-3 text-neutral-100 placeholder:text-muted focus:border-primary focus:outline-none';

  return (
    <div className="relative" data-testid="admin-setup-wizard">
      <DocumentTitle parts={[t('setup.title', { defaultValue: 'Create admin account' })]} />
      <div className="bg-neutral-900 flex min-h-screen items-center justify-center px-4 py-10">
        <div className="relative isolate flex w-full max-w-md flex-col gap-6 rounded-2xl border border-neutral-700 bg-neutral-900/80 p-8">
          <LoginAurora />
          <div className="relative z-10 flex flex-col gap-2 text-center">
            <h2 className="text-3xl text-neutral-100">
              {t('setup.title', { defaultValue: 'Create admin account' })}
            </h2>
            <p className="text-sm text-muted">
              {t('setup.subtitle', {
                defaultValue:
                  'This is the first run of the app. Create the admin account to continue — it can add members and assign roles.',
              })}
            </p>
          </div>
          <form
            className="relative z-10 flex flex-col gap-4"
            data-testid="admin-setup-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="flex flex-col gap-1 text-sm text-neutral-200">
              {t('setup.name', { defaultValue: 'Admin name' })}
              <input
                type="text"
                value={name}
                maxLength={80}
                autoComplete="off"
                data-testid="admin-setup-name"
                placeholder={t('setup.namePlaceholder', { defaultValue: 'e.g. Admin' })}
                className={inputClass}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-neutral-200">
              {t('setup.pin', { defaultValue: 'PIN (4 digits)' })}
              <input
                type="password"
                inputMode="numeric"
                value={pin}
                maxLength={4}
                autoComplete="new-password"
                data-testid="admin-setup-pin"
                placeholder="••••"
                className={cn(inputClass, 'tracking-[0.5em]')}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-neutral-200">
              {t('setup.confirmPin', { defaultValue: 'Confirm PIN' })}
              <input
                type="password"
                inputMode="numeric"
                value={confirmPin}
                maxLength={4}
                autoComplete="new-password"
                data-testid="admin-setup-confirm-pin"
                placeholder="••••"
                className={cn(inputClass, 'tracking-[0.5em]')}
                onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              />
            </label>
            {error && (
              <div className="alert alert-danger" role="alert" data-testid="admin-setup-error">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={submitting}
              data-testid="admin-setup-submit"
              className={cn(
                'btn btn-filled lg w-full',
                submitting && 'opacity-60'
              )}
            >
              {submitting
                ? t('setup.creating', { defaultValue: 'Creating…' })
                : t('setup.submit', { defaultValue: 'Create admin' })}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
