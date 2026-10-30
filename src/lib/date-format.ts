/**
 * Luxon format strings for the whole app.
 *
 * These used to be read as `import.meta.env.VITE_DATE_FORMAT as string` at ~18
 * call sites with no fallback. Vite only exposes `VITE_*` variables that are
 * actually set, so a deployment without `.env` produced `undefined` and Luxon
 * threw `fromFormat requires an input string and a format` — that is what the
 * six report-boundary tests were hitting, and the same crash sat behind the
 * matching production paths. `.env.example` also wrote
 * `VITE_DATE_TIME_FORMAT="${VITE_DATE_FORMAT} ${VITE_TIME_FORMAT}"`, and Vite
 * does not interpolate env references, so even a copied file yielded the
 * literal `${...}` text.
 *
 * Defaults mirror `.env.example`, so behaviour is unchanged when the vars are
 * set; unset or un-expanded values now fall back instead of throwing.
 */
const envFormat = (value: string | undefined, fallback: string): string => {
  const trimmed = (value ?? '').trim();
  const looksUnexpanded = trimmed.includes('${');
  return trimmed && !looksUnexpanded ? trimmed : fallback;
};

/**
 * Same fallback rule as the shared constants, for call sites that carry their
 * own default (e.g. a report header that predates `VITE_DATE_FORMAT`).
 */
export const formatWithFallback = envFormat;

export const DATE_FORMAT = envFormat(import.meta.env.VITE_DATE_FORMAT, 'yyyy-MM-dd');

export const TIME_FORMAT = envFormat(import.meta.env.VITE_TIME_FORMAT, 'HH:mm');

export const DATE_TIME_FORMAT = envFormat(
  import.meta.env.VITE_DATE_TIME_FORMAT,
  `${DATE_FORMAT} ${TIME_FORMAT}`,
);

/** Human-readable date+time; `ff` is the Luxon system-wide medium format. */
export const DATE_HUMAN_FORMAT = envFormat(import.meta.env.VITE_DATE_HUMAN_FORMAT, 'ff');
