/**
 * Temporary per-module access granted by a manager PIN unlock.
 *
 * The sidebar lets an unauthorized user open a locked module after a manager
 * authenticates (security modal). That approval is session-scoped: without
 * recording it, a route-level permission guard would immediately bounce the
 * user off the module the manager just unlocked.
 *
 * Stored in sessionStorage so it dies with the tab and never outlives logout.
 */
const ELEVATION_KEY = 'rm-elevated-modules';
const ELEVATION_TTL_MS = 15 * 60 * 1000;

type ModuleElevations = Record<string, number>;

const readElevations = (): ModuleElevations => {
  try {
    const raw = sessionStorage.getItem(ELEVATION_KEY);
    return raw ? (JSON.parse(raw) as ModuleElevations) : {};
  } catch {
    return {};
  }
};

const writeElevations = (elevations: ModuleElevations): void => {
  try {
    sessionStorage.setItem(ELEVATION_KEY, JSON.stringify(elevations));
  } catch {
    // storage unavailable — elevation just becomes ephemeral-in-memory-noop
  }
};

/** Record that `module` was unlocked by manager approval (expires after TTL). */
export const grantModuleElevation = (module?: string): void => {
  if (!module) return;
  const elevations = readElevations();
  const now = Date.now();
  for (const key of Object.keys(elevations)) {
    if (elevations[key] < now) delete elevations[key];
  }
  elevations[module] = now + ELEVATION_TTL_MS;
  writeElevations(elevations);
};

export const hasModuleElevation = (module?: string): boolean => {
  if (!module) return false;
  const elevations = readElevations();
  const until = elevations[module];
  if (!until) return false;
  if (until < Date.now()) {
    delete elevations[module];
    writeElevations(elevations);
    return false;
  }
  return true;
};

export const clearModuleElevations = (): void => {
  try {
    sessionStorage.removeItem(ELEVATION_KEY);
  } catch {
    // ignore
  }
};
