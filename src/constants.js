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

/** Which devices carry the production index (manifest `index_source`). */
export const INDEX_SOURCES = ['plant', 'inverters', 'none'];

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
 * The margin of the guard (kW): 1.25 x the peak power typed in the
 * configuration (bounded to MAX_KW_MIN..MAX_KW_MAX), else INDEX_MAX_KW (a
 * large home installation of Hypontech inverters).
 */
export const INDEX_MAX_KW = 60;
export const MAX_KW_MIN = 2;
export const MAX_KW_MAX = 1250;
/** kWh always accepted on top of maxKw x hours (rounding, a late upload). */
export const INDEX_SLACK_KWH = 0.5;
/** At most this many index states kept in /data. */
export const MAX_KEPT_INDEXES = 64;

/** A power above this (W) is a glitch: not published. */
export const POWER_MAX = 2_000_000;
/** A counter of the day above this (kWh) is a glitch: not published. */
export const DAY_ENERGY_MAX = 20_000;
/** A lifetime total above this (kWh) is a glitch: never an index. */
export const TOTAL_MAX = 1_000_000_000;
