// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized:
// the account of the Hypon cloud portal (username, password, OEM portal),
// which devices carry the production index, the optional peak power and the
// pace. The password never leaves this object but for the login request.
// -----------------------------------------------------------------------------

import { INDEX_SOURCES, OEMS, POLL_DEFAULT_MIN, POLL_MAX_MIN, POLL_MIN_MIN } from './constants.js';

const text = (value, max) => (typeof value === 'string' && value.length <= max ? value.trim() : '');

/** A number typed as a number or as text ("3,5"), else undefined. */
function numberOf(raw) {
  const value = typeof raw === 'string' ? raw.trim().replace(',', '.') : raw;
  if (value === '' || value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' && !/^\d{1,4}(\.\d{1,3})?$/.test(value)) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * The optional peak power of the installation (kWp, manifest `peak_power_kw`):
 * a number from 0.1 to 1000, else undefined (the default margin is then used).
 */
export function peakOf(raw) {
  const value = numberOf(raw);
  return value !== undefined && value >= 0.1 && value <= 1000 ? value : undefined;
}

/** The minutes between two reads: POLL_MIN_MIN to POLL_MAX_MIN, POLL_DEFAULT_MIN otherwise. */
export function pollOf(raw) {
  const value = numberOf(raw);
  if (value === undefined) {
    return POLL_DEFAULT_MIN;
  }
  return Math.min(POLL_MAX_MIN, Math.max(POLL_MIN_MIN, Math.round(value)));
}

export function normalizeConfig(raw = {}) {
  const oem = Number(typeof raw?.oem === 'string' ? raw.oem.trim() : raw?.oem);
  return {
    // Kept as typed but for the spaces around it (a login name or an e-mail address).
    username: text(raw?.username, 254),
    // Never trimmed: a password may start or end with a space.
    password: typeof raw?.password === 'string' && raw.password.length <= 256 ? raw.password : '',
    oem: OEMS.includes(oem) ? oem : 0,
    indexSource: INDEX_SOURCES.includes(raw?.index_source) ? raw.index_source : 'plant',
    peakKw: peakOf(raw?.peak_power_kw),
    pollMinutes: pollOf(raw?.poll_minutes),
  };
}

/** Whether the form is complete enough to log in. */
export const isComplete = (config) => Boolean(config.username && config.password);
