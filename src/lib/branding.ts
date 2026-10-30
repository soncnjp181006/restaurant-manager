import { Tables } from '@/api/db/tables.ts';
import type { useDB } from '@/api/db/db.ts';
import {
  BRANDING_KEY,
  BrandingSettings,
  brandingLogoToDataUri,
} from '@/api/model/branding.ts';
import {
  getGatewayBaseUrl,
  isGatewayAuthEnabled,
} from '@/lib/session.ts';

/**
 * Projection of the real `useDB()` façade instead of a hand-written clone: the
 * driver's query() is generic (`<R extends unknown[]> => Promise<R>`) because a
 * caller declares the per-statement result tuple (see the `query<Array<...>>`
 * below), and a hand-written `<T = unknown> => Promise<T>` signature promises a
 * type the caller chooses freely — which the real db cannot honour.
 */
type DbQueryClient = Pick<ReturnType<typeof useDB>, 'query'>;

/**
 * Load the restaurant brand logo for the login screen.
 * Gateway mode uses the public /auth/branding route (no DB session yet).
 * Legacy mode reads the setting row directly from Surreal.
 */
export async function fetchLoginBrandLogo(
  db?: DbQueryClient | null,
): Promise<string | null> {
  if (isGatewayAuthEnabled()) {
    try {
      const res = await fetch(`${getGatewayBaseUrl()}/auth/branding`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        logo?: string | null;
      };
      if (!data.ok || typeof data.logo !== 'string' || !data.logo) {
        return null;
      }
      return data.logo;
    } catch {
      return null;
    }
  }

  if (!db) return null;

  try {
    const [rows] = await db.query<Array<{ values?: BrandingSettings }>>(
      `SELECT values FROM ${Tables.settings} WHERE key = $key AND is_global = true LIMIT 1`,
      { key: BRANDING_KEY },
    );
    const values = rows?.[0]?.values;
    return brandingLogoToDataUri(values?.logo, values?.mime);
  } catch {
    return null;
  }
}
