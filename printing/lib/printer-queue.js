'use strict';

/**
 * Serialize print jobs that target the same physical device.
 * Concurrent KOTs (kitchen1 + kitchen2 → same printer) otherwise interleave
 * ESC/POS buffers so only the last job's cut runs.
 */

/** @type {Map<string, Promise<unknown>>} */
const tails = new Map();

/**
 * Stable key for a printer driver config.
 * @param {Object} printer
 * @returns {string}
 */
function printerLockKey(printer) {
  const p = printer && typeof printer === 'object' ? printer : {};
  const type = String(p.type || 'network').toLowerCase();
  if (type === 'usb') {
    const vid = p.vid != null ? String(p.vid) : '';
    const pid = p.pid != null ? String(p.pid) : '';
    const id = p.id != null ? String(p.id) : '';
    return `usb:${vid}:${pid}:${id}`;
  }
  if (type === 'serial') {
    return `serial:${p.path || p.port || p.device || ''}`;
  }
  if (type === 'bluetooth') {
    return `bt:${p.address || p.mac || ''}:${p.channel || 1}`;
  }
  const host = p.ip || p.address || p.host || '';
  const port = p.port != null && p.port !== '' ? p.port : 9100;
  return `net:${host}:${port}`;
}

/**
 * Run fn exclusively for this printer. Jobs for other printers still run in parallel.
 * @template T
 * @param {Object} printer
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withPrinterLock(printer, fn) {
  const key = printerLockKey(printer);
  const prev = tails.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => fn());
  // Keep queue moving even when a job fails.
  tails.set(key, run.catch(() => {}));
  return run;
}

module.exports = {
  printerLockKey,
  withPrinterLock,
};
