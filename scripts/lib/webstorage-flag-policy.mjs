/**
 * --no-webstorage injection policy (shared by vitest.config.ts and tests).
 *
 * Node >=25 ships an experimental Web Storage global whose localStorage
 * shadows jsdom's (missing clear/removeItem) — tests must disable it, and
 * NODE_OPTIONS is the only reliable way to reach forked workers.
 * Node <25 (e.g. the Node 22 CI runners) REJECTS the flag outright:
 *   "--no-webstorage is not allowed in NODE_OPTIONS"
 * which used to kill every vitest worker at spawn and hang CI for the full
 * timeout. Electron's built-in Node (METIS_ELECTRON_NODE=1) also rejects it.
 */
export function shouldInjectNoWebstorage(nodeVersion, env = process.env) {
  if (env.METIS_ELECTRON_NODE) return false;
  const major = Number(String(nodeVersion).split('.')[0]);
  return Number.isFinite(major) && major >= 25;
}
