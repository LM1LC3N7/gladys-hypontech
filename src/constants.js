// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (actions,
// manifest keys, external id types, feature keys in src/devices.js) is
// forever: never rename one.
// -----------------------------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection', ACCEPT_HELD: 'accept_held_index' };

/**
 * External ids (forever), `ext:<selector>:<type>:<id>`:
 * - a plant: `plant:<plant_id>`, the id the Hypon cloud gives the plant;
 * - an inverter: `inverter:<sn>`, its serial number;
 * - a battery: `battery:<sn>`, its serial number.
 * An item without a usable id (missing, or not 1 to 64 letters, digits, `_`
 * or `-`) gets no device: it is counted in the status, never guessed.
 */
export const TYPES = { PLANT: 'plant', INVERTER: 'inverter', BATTERY: 'battery' };
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Which devices carry the production index (manifest `index_source`); the first is the default. */
export const INDEX_SOURCES = ['inverters', 'plant', 'none'];

/** The OEM portals the library knows (its oems.csv): the `oem` sent at login. */
export const OEMS = [0, 3, 4];

// --- The Hypon cloud (as the hyponcloud library reads it) ------------------------------
export const API_BASE = 'https://api.hypon.cloud/v2';
/** The library waits 10 s per request; so do we, the body included. */
export const HTTP_TIMEOUT = 10_000;
/** A page of 10 plants, inverters or batteries is a few KiB: more is not an answer. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Pages read at most per list (10 items a page). */
export const MAX_PAGES = 10;
/** Plants read at most (their inverters, batteries and monitor). */
export const MAX_PLANTS = 10;
/** The token lives 1 h (the library's `token_validity`); renewed 5 min before. */
export const TOKEN_VALIDITY = 60 * 60_000;
export const TOKEN_MARGIN = 5 * 60_000;
/** The longest text kept from an answer (a name, a model, a status). */
export const MAX_TEXT = 64;

// --- Schedule ------------------------------------------------------------------------
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** One read every `poll_minutes`: 5 by default, 2 at least, 60 at most. */
export const POLL_DEFAULT_MIN = 5;
export const POLL_MIN_MIN = 2;
export const POLL_MAX_MIN = 60;
/** A failed read (network, odd answer): the next try doubles, up to this. */
export const RETRY_MAX = HOUR;
/** HTTP 429 or 5xx on the login or the plant list: a pause from 1 min to 6 h, kept in /data. */
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** The time of the last read is written in /data at most once per this delay. */
export const ATTEMPT_SAVE_EVERY = MINUTE;
/** A plant without battery is asked again for its batteries after this delay. */
export const NO_BATTERY_RETRY = 6 * HOUR;
/** Unchanged values are sent again after this delay (publishChangedStates heartbeat). */
export const STATE_HEARTBEAT = 30 * MINUTE;
/** The test button answers within this delay (the manifest gives it 30 s). */
export const TEST_ANSWER_WITHIN = 20 * SECOND;
/** The second click of "Accept the held index" must come within this delay of the first. */
export const ACCEPT_CONFIRM_WITHIN = 5 * MINUTE;
/** A plant whose last update in the cloud is older than this: its power is not sent. */
export const PLANT_STALE_AFTER = 2 * HOUR;
/** States sent to Gladys at most per minute (the core refuses more: 300), all devices together. */
export const STATES_PER_MINUTE = 280;

// --- Energy index (the lifetime total of the cloud, src/guard.js) --------------------
/**
 * The margin of the guard (kW), one per index (review 1, I2, as
 * gladys-zeversolar 0.1.4):
 * - a plant: 1.25 x the peak power typed, else 1.5 x the highest plausible
 *   power the cloud gave for it over 30 days (once 7 days are known), else
 *   INDEX_MAX_KW;
 * - an inverter: 1.5 x its own highest power over 30 days (7 days known),
 *   else 1.25 x the peak power typed, else INVERTER_MAX_KW (the largest
 *   Hypontech hybrid inverters are 12 kW);
 * - widened for one read to 1.5 x the plausible power of that read (n1);
 * bounded to MAX_KW_MIN..MAX_KW_MAX.
 */
export const INDEX_MAX_KW = 60;
export const INVERTER_MAX_KW = 15;
export const MAX_KW_MIN = 0.5;
export const MAX_KW_MAX = 1250;
/** Days of power peaks needed before the learned margin is used, and kept. */
export const PEAK_DAYS_MIN = 7;
export const PEAK_DAYS_KEPT = 30;
/** A power above this many times the peak (typed or learned) is a glitch unless seen twice in a row. */
export const PEAK_OUTLIER = 1.5;
/** A power above this (W) is aberrant: never a peak, never in a margin. */
export const PLAUSIBLE_INVERTER_W = 30_000;
export const PLAUSIBLE_PLANT_W = MAX_KW_MAX * 1000;
/** kWh always accepted on top of maxKw x hours (rounding, a late upload). */
export const INDEX_SLACK_KWH = 0.5;
/**
 * The plant total is used only when it reaches the sum of the highest totals
 * seen for its inverters, within this per inverter (the plant total is
 * rounded to 0.1 kWh, the inverters' to 0.01) plus INDEX_SUM_SLACK (B1 c).
 */
export const INDEX_SUM_PER_INVERTER = 0.1;
export const INDEX_SUM_SLACK = 0.05;
/** Index states, retired indexes and inverter totals kept in /data at most (I5). */
export const MAX_KEPT_INDEXES = 4096;
/** The local day of the power peaks: the TZ of the container, else Central European time. */
export const TIME_ZONE = process.env.TZ || 'Europe/Paris';

/** A power above this (W) is a glitch: not published. */
export const POWER_MAX = 2_000_000;
/** A counter of the day above this (kWh) is a glitch: not published. */
export const DAY_ENERGY_MAX = 20_000;
/** A lifetime total above this (kWh) is a glitch: never an index. */
export const TOTAL_MAX = 1_000_000_000;
