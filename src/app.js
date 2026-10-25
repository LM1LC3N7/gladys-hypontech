// -----------------------------------------------------------------------------
// The integration itself: the Hypon cloud account read every `poll_minutes`
// (5 by default), its plants, inverters and batteries as devices, the
// production index (the lifetime total of the cloud) checked by its guard,
// the pauses and the refusal kept in /data, the test and accept buttons.
// index.js only wires the SDK handlers to it. Read-only: nothing is ever sent
// to the cloud but the login and GETs.
//
// The pace is global and kept across restarts: never two reads less than an
// interval apart, whatever asks (a reconnection, a save of the form, the test
// button, the Discover tab, a device created, a restart of the container: the
// time of the last read is kept in /data, written BEFORE the read).
//
// A read belongs to its session (the client of one account): when the
// account changes, a late answer of the old one publishes nothing and sets no
// status (checked after every await). One read at a time: a new account waits
// for the end of the old read.
//
// Credentials refused by the cloud: final, kept in /data as a salted
// fingerprint, no new try by itself; other credentials saved, or the test
// button (one try, never sooner than the interval), and the refusal is erased
// only by a login that works.
//
// The production index (review 1):
// - one margin per index, from the power the cloud gives for its source
//   (learned over 30 days, or the peak power typed), widened for one read by
//   the plausible power of that read (I2, as gladys-zeversolar 0.1.4);
// - a reading EQUAL to the reference while its source produces nothing (the
//   night) dates the reference now: the hours of the night never widen the
//   margin of the morning (B1 b);
// - the total of a plant is used only when its inverters were read and it
//   reaches the sum of the highest totals seen for them (B1 c): a partial sum
//   (an inverter offline) or a total of one inverter alone is never counted;
// - a drop is never accepted (I1): it corrects itself when the total comes
//   back;
// - an index of a level left (`index_source` changed) is retired for good,
//   kept in /data: it never receives a value again, even if the level comes
//   back (B2); a device deleted and created again starts afresh.
//
// The created devices are read from `gladys.devices`, which the SDK keeps up
// to date: never a copy of our own.
//
// Two clocks: `now` (wall clock) dates the index and what /data keeps;
// `monotonic` paces the reads, so that a wall clock set back never stops them.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { isComplete, normalizeConfig } from './config.js';
import {
  ACCEPT_CONFIRM_WITHIN,
  ATTEMPT_SAVE_EVERY,
  INDEX_MAX_KW,
  INDEX_SLACK_KWH,
  INDEX_SOURCES,
  INDEX_SUM_PER_INVERTER,
  INDEX_SUM_SLACK,
  INVERTER_MAX_KW,
  MAX_KEPT_INDEXES,
  MAX_KW_MAX,
  MAX_KW_MIN,
  MAX_PLANTS,
  NO_BATTERY_RETRY,
  PAUSE_MAX,
  PAUSE_MIN,
  PEAK_DAYS_KEPT,
  PEAK_DAYS_MIN,
  PEAK_OUTLIER,
  PLANT_STALE_AFTER,
  PLAUSIBLE_INVERTER_W,
  PLAUSIBLE_PLANT_W,
  POWER_MAX,
  RETRY_MAX,
  STATE_HEARTBEAT,
  STATES_PER_MINUTE,
  TEST_ANSWER_WITHIN,
  TIME_ZONE,
  TOTAL_MAX,
  TYPES,
} from './constants.js';
import {
  FEATURE,
  batteryStates,
  buildBattery,
  buildInverter,
  buildPlant,
  ids,
  inverterStates,
  keepCreatedFeatures,
  plantStates,
  round,
} from './devices.js';
import { IndexGuard } from './guard.js';
import { T } from './i18n.js';
import { HyponClient, HyponError } from './hypon/client.js';
import { idOf, parseBattery, parseInverter, parsePlant } from './hypon/model.js';
import { createFileStore, credentialsHash } from './store.js';

const defaultTimers = { setTimeout, clearTimeout };
const MINUTE = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The level ('plant' | 'inverter') of an index feature external id, else undefined. */
const INDEX_ID = new RegExp(`:(plant|inverter):[A-Za-z0-9_-]{1,64}:${FEATURE.PRODUCTION_INDEX}$`);
export const levelOfIndex = (id) => INDEX_ID.exec(id)?.[1];
const TYPE_OF_SOURCE = { plant: 'plant', inverters: 'inverter', none: undefined };

/** The index Gladys already holds for a feature of a created device, when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/** A pause read back from /data: `{ until, count, code, status }`, its end capped from now. */
function validPause(pause, now) {
  if (
    !pause ||
    !finite(pause.until) ||
    !Number.isInteger(pause.count) ||
    pause.count < 1 ||
    (pause.code !== 'rate_limited' && pause.code !== 'server')
  ) {
    return undefined;
  }
  return {
    until: Math.min(pause.until, now + PAUSE_MAX),
    count: Math.min(pause.count, 32),
    code: pause.code,
    status: Number.isInteger(pause.status) ? pause.status : null,
  };
}

/** The refusal read back from /data: `{ hash, at, status }`. */
const validRefused = (refused, now) =>
  refused && typeof refused.hash === 'string' && HEX64.test(refused.hash)
    ? {
        hash: refused.hash,
        at: finite(refused.at) ? Math.min(refused.at, now) : now,
        status: Number.isInteger(refused.status) ? refused.status : null,
      }
    : undefined;

/** The index states kept in /data: plain objects under string keys only. */
function keptIndexes(indexes) {
  if (!isObject(indexes)) {
    return {};
  }
  const kept = {};
  for (const [key, value] of Object.entries(indexes)) {
    if (key !== '__proto__' && key.length <= 200 && isObject(value)) {
      kept[key] = value;
    }
  }
  return kept;
}

/** The retired index features kept in /data: `id -> at` (B2). */
function keptRetired(retired) {
  const map = new Map();
  if (isObject(retired)) {
    for (const [key, at] of Object.entries(retired)) {
      if (levelOfIndex(key) && finite(at)) map.set(key, at);
    }
  }
  return map;
}

/** The highest total seen per inverter serial (B1 c). */
function keptTotals(totals) {
  const map = new Map();
  if (isObject(totals)) {
    for (const [sn, value] of Object.entries(totals)) {
      if (idOf(sn) && finite(value) && value > 0 && value <= TOTAL_MAX) map.set(sn, value);
    }
  }
  return map;
}

/** The daily power peaks of an index: `[{ day, w }]`, valid, the last PEAK_DAYS_KEPT days. */
export function validPeaks(peaks) {
  if (!Array.isArray(peaks)) {
    return [];
  }
  return peaks
    .filter(
      (p) =>
        isObject(p) &&
        typeof p.day === 'string' &&
        DAY.test(p.day) &&
        finite(p.w) &&
        p.w >= 0 &&
        p.w <= POWER_MAX,
    )
    .map((p) => ({ day: p.day, w: p.w }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .slice(-PEAK_DAYS_KEPT);
}

/** The peaks with the power `w` read on local `day`. */
export function withPeak(peaks, day, w) {
  const known = peaks.find((p) => p.day === day);
  if (known) {
    return known.w >= w ? peaks : peaks.map((p) => (p.day === day ? { day, w } : p));
  }
  return validPeaks([...peaks, { day, w }]);
}

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
/** The local day (YYYY-MM-DD) of an instant. */
export const localDay = (at) => dayFormat.format(at);

export const clampKw = (kw) => Math.min(MAX_KW_MAX, Math.max(MAX_KW_MIN, Math.ceil(kw * 2) / 2));

/**
 * The margin of an index (kW), before the widening of one read (I2):
 * - a plant: 1.25 x the peak power typed, else 1.5 x its highest power of
 *   the last 30 days once 7 days are known, else INDEX_MAX_KW;
 * - an inverter: 1.5 x its own highest power (7 days known), else 1.25 x
 *   the peak power typed, else INVERTER_MAX_KW.
 */
export function maxKwOf(kind, peakKw, peaks = []) {
  const learned =
    peaks.length >= PEAK_DAYS_MIN
      ? clampKw((1.5 * Math.max(...peaks.map((p) => p.w))) / 1000)
      : undefined;
  const typed = finite(peakKw) ? clampKw(1.25 * peakKw) : undefined;
  if (kind === 'plant') {
    return typed ?? learned ?? INDEX_MAX_KW;
  }
  return learned ?? typed ?? INVERTER_MAX_KW;
}

/** A lifetime total usable as an index: above 0, not absurd. */
const totalOf = (value) =>
  finite(value) && value > 0 && value <= TOTAL_MAX ? round(value, 3) : undefined;

export class HyponApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'hypontech' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    clientFactory = (options) => new HyponClient(options),
    store = createFileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.clientFactory = clientFactory;
    /** /data: salt, pace, pause, refusal, index guards, retired indexes, inverter totals. */
    this.store = store;
    this.savedKey = undefined;
    this.config = normalizeConfig();
    /** `{ client }` of the current account; replaced (never reused) when the account changes. */
    this.session = undefined;
    this.running = false;
    this.timer = undefined;
    this.busy = undefined;
    this.loopRun = Promise.resolve();
    this.lifecycle = Promise.resolve();
    this.lastStatus = undefined;

    const kept = store.load();
    const at = now();
    this.salt =
      typeof kept.salt === 'string' && HEX64.test(kept.salt)
        ? kept.salt
        : randomBytes(32).toString('hex');
    this.pause = validPause(kept.pause, at);
    this.refused = validRefused(kept.refused, at);
    // The last read before a restart: the next one never comes sooner than
    // the interval (a date in the future, a clock set back, is brought to now).
    this.lastAttemptAt = finite(kept.lastAttemptAt) ? Math.min(kept.lastAttemptAt, at) : undefined;
    this.savedAttemptAt = this.lastAttemptAt;
    /** Monotonic time of the last read started. */
    this.lastReadAt =
      this.lastAttemptAt === undefined ? undefined : monotonic() - (at - this.lastAttemptAt);
    /** The level of the index of the last start (B2): a change retires the former one. */
    this.indexLevel = INDEX_SOURCES.includes(kept.indexLevel) ? kept.indexLevel : undefined;
    /** Index features retired for good: `id -> at` (B2). */
    this.retired = keptRetired(kept.retired);
    /** The highest lifetime total seen per inverter serial (B1 c). */
    this.inverterTotals = keptTotals(kept.inverterTotals);
    /** By index feature external id: IndexGuard, its label, its power peaks. */
    this.guards = new Map();
    this.labels = new Map();
    this.peaks = new Map();
    /** By index feature external id: a power above the learned top, seen once (n1). */
    this.outliers = new Map();
    /** States sent to Gladys: `[{ at (monotonic), count }]`, the last minute. */
    this.sent = [];
    this.pendingAccept = undefined;
    this.resetReads();
  }

  /** What belongs to one account: forgotten when it changes. */
  resetReads() {
    /** The last read: `{ at (monotonic), kind: 'ok' | 'error', counts?, err? }`. */
    this.outcome = undefined;
    /** The last data read: `{ plants: [{ plant, monitor, inverters, batteries, ... }] }`. */
    this.data = undefined;
    /** By plant id: what its monitor showed (`{ grid, load, battery }`), only grows. */
    this.caps = new Map();
    /** By plant id: monotonic time from which its batteries are asked again (none found). */
    this.batteryNextAt = new Map();
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    this.notes = freshNotes();
    this.discoveredKey = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  start(raw = {}) {
    return this.serialize(() => this.doStart(raw));
  }

  stop() {
    return this.serialize(() => this.doStop());
  }

  /** Resolves once every queued start/stop and the read running are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.loopRun;
    await this.busy;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async doStart(raw) {
    this.doStop();
    const config = normalizeConfig(raw);
    const first = this.session === undefined;
    const changed =
      first ||
      config.username !== this.config.username ||
      config.password !== this.config.password ||
      config.oem !== this.config.oem;
    this.config = config;
    let levelChanged = false;
    if (config.indexSource !== this.indexLevel) {
      // Another level for the index: the indexes of the former one are
      // retired for good (B2), never fed again.
      if (this.indexLevel !== undefined) {
        this.retireLevel(this.indexLevel);
      }
      this.indexLevel = config.indexSource;
      levelChanged = true;
    }
    if (changed) {
      const session = {};
      session.client = isComplete(config)
        ? this.clientFactory({
            username: config.username,
            password: config.password,
            oem: config.oem,
            now: this.now,
            onLogin: () => this.loggedIn(session),
          })
        : undefined;
      this.session = session;
      if (!first) {
        // Another account: its own story. The pace stays (never two reads
        // less than an interval apart), and so does a pause of the cloud.
        this.resetReads();
      }
    }
    if (levelChanged) {
      await this.saveState();
    }
    this.pendingAccept = undefined;
    this.running = true;
    // The core keeps the connection status, the Discovery list and the last
    // values in memory: a restarted Gladys has lost them, so they are always
    // sent again (the values at the next read).
    this.lastStatus = undefined;
    this.discoveredKey = undefined;
    this.gladys.forgetPublishedStates?.();
    if (!this.session.client) {
      await this.setStatus(false, T.incomplete);
      return;
    }
    await this.discover();
    await this.updateStatus();
    this.schedule();
  }

  doStop() {
    this.running = false;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Every index feature of `level` (a source of the form), known anywhere, retired now. */
  retireLevel(level) {
    const type = TYPE_OF_SOURCE[level];
    if (!type) {
      return;
    }
    const known = new Set([
      ...this.guards.keys(),
      ...Object.keys(keptIndexes(this.store.load().indexes)),
    ]);
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        if (typeof feature?.external_id === 'string') known.add(feature.external_id);
      }
    }
    const at = this.now();
    for (const id of known) {
      if (levelOfIndex(id) === type) {
        if (!this.retired.has(id)) this.retired.set(id, at);
        this.guards.delete(id);
      }
    }
    this.pendingAccept = undefined;
    this.logger.info(`Hypontech: the indexes of the level "${level}" are retired`);
  }

  // --- Pace ------------------------------------------------------------------

  interval() {
    return this.config.pollMinutes * MINUTE;
  }

  /** The credentials of the configuration are the ones the cloud refused. */
  isRefused() {
    return Boolean(
      this.refused &&
      this.session?.client &&
      this.refused.hash === credentialsHash(this.salt, this.config),
    );
  }

  /** The monotonic time from which the next read may start (pace, retries, pause), from the caller's instant `mono` (the clock is read once per decision). */
  dueAt(mono) {
    let due = this.lastReadAt === undefined ? mono : this.lastReadAt + this.interval();
    if (this.nextTryAt !== undefined) {
      due = Math.max(due, this.nextTryAt);
    }
    const now = this.now();
    if (this.pause && now < this.pause.until) {
      due = Math.max(due, mono + (this.pause.until - now));
    }
    return due;
  }

  /** One timer: the next read when it is due; none while the credentials are refused. */
  schedule() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.running || !this.session?.client || this.isRefused()) {
      return;
    }
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.loopRun = this.loop();
      return this.loopRun;
    }, wait);
  }

  async loop() {
    const session = this.session;
    try {
      await this.tick();
    } catch (err) {
      this.logger.error(`Hypontech: unexpected error (${err?.name ?? 'Error'})`);
    }
    if (session === this.session && this.running) {
      this.schedule();
    }
  }

  /**
   * One read when it is due; a read running is never doubled. A read of a
   * former account is let finish (it publishes nothing), then this one runs.
   */
  tick(options) {
    if (this.busy) {
      if (this.busySession === this.session) {
        return this.busy;
      }
      return this.busy.then(() => this.tick(options));
    }
    this.busySession = this.session;
    this.busy = this.read(options).finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  /** `retryRefused`: the test button's one try with refused credentials. */
  async read({ retryRefused = false } = {}) {
    const session = this.session;
    const client = session?.client;
    if (!client || !this.running) {
      return;
    }
    if (this.isRefused() && !retryRefused) {
      return;
    }
    const mono = this.monotonic();
    if (mono < this.dueAt(mono)) {
      return;
    }
    /** Another account (or a stop) during an await: this read gives up, silently. */
    const gone = () => session !== this.session || !this.running;
    this.lastReadAt = mono;
    // Kept BEFORE the requests: a restart during them never reads again sooner.
    await this.saveAttempt(this.now());
    if (gone()) return;
    client.beginRead();
    let listed;
    try {
      listed = await client.readPlants();
    } catch (err) {
      if (gone()) return;
      await this.failed(err, mono, gone);
      return;
    }
    if (gone()) return;
    const notes = { pages: new Set(), truncated: listed.truncated, skipped: 0 };
    const plants = [];
    for (const item of listed.items) {
      const plant = parsePlant(item);
      if (plant) {
        plants.push({
          plant,
          monitor: undefined,
          inverters: [],
          invertersRead: false,
          batteries: [],
        });
      } else {
        notes.skipped += 1;
      }
    }
    if (plants.length > MAX_PLANTS) {
      plants.length = MAX_PLANTS;
      notes.truncated = true;
    }
    // The secondary pages of each plant: a failure never holds back the
    // plant list; a 429 of the account stops the next ones.
    let stopped;
    for (const entry of plants) {
      if (stopped) break;
      const id = entry.plant.id;
      const pages = [
        ['monitor', () => client.readMonitor(id), (m) => (entry.monitor = m)],
        [
          'inverters',
          () => client.readInverters(id),
          (r) => {
            this.collect(r, parseInverter, entry.inverters, notes);
            entry.invertersRead = true;
          },
        ],
      ];
      if (mono >= (this.batteryNextAt.get(id) ?? 0)) {
        pages.push([
          'batteries',
          () => client.readBatteries(id),
          (r) => {
            this.collect(r, parseBattery, entry.batteries, notes);
            if (entry.batteries.length === 0) this.batteryNextAt.set(id, mono + NO_BATTERY_RETRY);
            else this.batteryNextAt.delete(id);
          },
        ]);
      } else {
        // Asked again later (none last time): what was known is kept.
        entry.batteries = this.previous(id, 'batteries');
      }
      for (const [name, request, take] of pages) {
        try {
          take(await request());
        } catch (err) {
          if (gone()) return;
          if (err instanceof HyponError && err.final) {
            await this.failed(err, mono, gone);
            return;
          }
          if (name === 'batteries' && err?.code === 'not_found') {
            // No battery page for this plant: asked again much later.
            this.batteryNextAt.set(id, mono + NO_BATTERY_RETRY);
            continue;
          }
          if (name === 'inverters') {
            // Kept as known (m2), but nothing of them is sent this time.
            entry.inverters = this.previous(id, 'inverters');
            entry.invertersRead = false;
          }
          notes.pages.add(name);
          this.logger.warn(`Hypon ${name} page unavailable (${err?.code ?? 'error'})`);
          if (err?.code === 'rate_limited') {
            // The account is limited: no more requests in this read.
            stopped = err;
            break;
          }
        }
        if (gone()) return;
      }
    }
    // Plants not reached (a 429): their inverters as known, nothing sent for them.
    for (const entry of plants) {
      if (!entry.invertersRead && entry.inverters.length === 0) {
        entry.inverters = this.previous(entry.plant.id, 'inverters');
      }
    }
    await this.succeeded({ plants }, notes, mono, gone, stopped);
  }

  /** The items of a list parsed into `into`; those without a usable id counted. */
  collect(result, parse, into, notes) {
    for (const item of result.items) {
      const parsed = parse(item);
      if (parsed) into.push(parsed);
      else notes.skipped += 1;
    }
    if (result.truncated) notes.truncated = true;
  }

  /** The inverters or batteries of a plant as the previous read gave them. */
  previous(plantId, what) {
    return this.data?.plants.find((p) => p.plant.id === plantId)?.[what] ?? [];
  }

  async saveAttempt(now) {
    this.lastAttemptAt = now;
    if (
      this.savedAttemptAt === undefined ||
      now < this.savedAttemptAt ||
      now - this.savedAttemptAt >= ATTEMPT_SAVE_EVERY
    ) {
      this.savedAttemptAt = now;
      await this.saveState();
    }
  }

  /**
   * A login of the current account worked: the refusal (of these credentials
   * or of former ones) is erased at once: /data never keeps the fingerprint
   * of a refused password after a success.
   */
  loggedIn(session) {
    if (session !== this.session || !this.refused) {
      return;
    }
    this.refused = undefined;
    this.saveState().catch(() => {});
  }

  // --- Outcomes ----------------------------------------------------------------

  async succeeded(data, notes, mono, gone, stopped) {
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    if (stopped) {
      // The plant list answered, a later page asked to wait: published, then paused.
      this.setPause(stopped);
    } else {
      this.pause = undefined;
    }
    this.data = data;
    const now = this.now();
    let stale = 0;
    for (const entry of data.plants) {
      entry.stale =
        entry.plant.updatedAt !== undefined && now - entry.plant.updatedAt > PLANT_STALE_AFTER;
      if (entry.stale) stale += 1;
      if (entry.monitor) {
        const caps = this.caps.get(entry.plant.id) ?? { grid: false, load: false, battery: false };
        this.caps.set(entry.plant.id, {
          grid: caps.grid || entry.monitor.has.grid,
          load: caps.load || entry.monitor.has.load,
          battery: caps.battery || entry.monitor.has.battery,
        });
      }
      if (entry.invertersRead) {
        // The highest total seen per inverter, for the check of the plant total.
        for (const inverter of entry.inverters) {
          const total = totalOf(inverter.energyTotal);
          if (total !== undefined && total > (this.inverterTotals.get(inverter.sn) ?? 0)) {
            this.inverterTotals.set(inverter.sn, total);
          }
        }
      }
    }
    this.notes = {
      ...freshNotes(),
      pages: [...notes.pages],
      truncated: notes.truncated,
      skipped: notes.skipped,
      stale,
    };
    this.outcome = { at: mono, kind: 'ok', counts: this.counts() };
    await this.discover();
    if (gone()) return;
    await this.publishAll(gone);
    if (gone()) return;
    await this.saveState();
    if (gone()) return;
    await this.updateStatus();
  }

  setPause(err) {
    const count = (this.pause?.count ?? 0) + 1;
    const asked = finite(err.retryAfter) ? err.retryAfter : PAUSE_MIN * 2 ** (count - 1);
    const wait = Math.min(Math.max(asked, PAUSE_MIN), PAUSE_MAX);
    this.pause = {
      until: this.now() + wait,
      count: Math.min(count, 32),
      code: err.code,
      status: Number.isInteger(err.status) ? err.status : null,
    };
  }

  async failed(err, mono, gone) {
    const code = err?.code ?? 'error';
    // Our own words only (HyponError codes): never a text of the cloud.
    this.logger.warn(
      `Hypon cloud read failed: ${code}${Number.isInteger(err?.status) ? ` ${err.status}` : ''}`,
    );
    this.outcome = { at: mono, kind: 'error', err };
    if (err instanceof HyponError && err.final) {
      // Refused credentials: final, kept in /data, no new try by itself.
      this.refused = {
        hash: credentialsHash(this.salt, this.config),
        at: this.now(),
        status: Number.isInteger(err.status) ? err.status : null,
      };
      this.failures = 0;
      this.nextTryAt = undefined;
      this.lastError = undefined;
      await this.saveState();
      if (gone()) return;
      await this.updateStatus();
      return;
    }
    if (code === 'rate_limited' || code === 'server') {
      this.setPause(err);
      await this.saveState();
      if (gone()) return;
      await this.updateStatus();
      return;
    }
    // Network, odd answer, refused session: retries doubled from the interval.
    const wait = Math.min(this.interval() * 2 ** this.failures, RETRY_MAX);
    this.failures += 1;
    this.lastError = err;
    this.nextTryAt = mono + wait;
    await this.updateStatus();
  }

  counts() {
    const plants = this.data?.plants ?? [];
    return {
      plants: plants.length,
      inverters: plants.reduce((n, p) => n + p.inverters.length, 0),
      batteries: plants.reduce((n, p) => n + p.batteries.length, 0),
    };
  }

  // --- Status ------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async updateStatus() {
    const [connected, message] = this.currentStatus();
    await this.setStatus(connected, message);
  }

  /** The status from what is known now: never a read. */
  currentStatus() {
    if (!this.session?.client) {
      return [false, T.incomplete];
    }
    if (this.isRefused()) {
      return [false, T.refused(this.refused.status)];
    }
    const held = this.heldItems();
    const notes = held.length > 0 ? [T.notes.held(held)] : [];
    const now = this.now();
    if (this.pause && now < this.pause.until) {
      return [false, T.paused(this.pause, this.pause.until - now, notes)];
    }
    if (this.lastError && this.failures > 0) {
      const wait = Math.max(0, (this.nextTryAt ?? 0) - this.monotonic());
      return [false, T.unreachable(this.lastError, wait, notes)];
    }
    if (!this.data) {
      const mono = this.monotonic();
      return [true, T.waiting(Math.max(0, this.dueAt(mono) - mono))];
    }
    if (this.data.plants.length === 0) {
      return [true, T.noPlant];
    }
    const extra = [];
    const created = this.createdDevices();
    if (created.length === 0) extra.push(T.notes.noDevice);
    if (this.notes.pages.length > 0) extra.push(T.notes.pages(this.notes.pages));
    if (this.notes.truncated) extra.push(T.notes.truncated);
    if (this.notes.skipped > 0) extra.push(T.notes.skipped(this.notes.skipped));
    if (this.notes.stale > 0) extra.push(T.notes.stale(this.notes.stale));
    if (this.notes.plantIncomplete > 0) {
      extra.push(T.notes.plantIncomplete(this.notes.plantIncomplete));
    }
    if (this.notes.budget) extra.push(T.notes.budget);
    if (this.config.indexSource === 'none') extra.push(T.notes.noIndex);
    const retired = this.retiredOfCreated(created);
    if (retired.count > 0) extra.push(T.notes.retired(retired.count, retired.since));
    if (this.indexMissing(created)) extra.push(T.notes.indexMissing(this.config.indexSource));
    return [true, T.ok(this.counts(), [...extra, ...notes])];
  }

  /** The created devices whose index feature is retired (B2): their count and the first date. */
  retiredOfCreated(created) {
    let count = 0;
    let since;
    for (const device of created) {
      const id = `${device.external_id}:${FEATURE.PRODUCTION_INDEX}`;
      const at = this.retired.get(id);
      if (at !== undefined && (device.features ?? []).some((f) => f.external_id === id)) {
        count += 1;
        since = since === undefined ? at : Math.min(since, at);
      }
    }
    return { count, since };
  }

  /**
   * Devices of the chosen level are created, but none of them carries a live
   * index (created before the level was chosen, m6): "Update" is needed.
   */
  indexMissing(created) {
    const type = TYPE_OF_SOURCE[this.config.indexSource];
    if (!type) {
      return false;
    }
    // A device whose index is retired is told by its own note (delete and
    // create it again): "Update" would not resume it (approval 1, r3).
    const level = created.filter(
      (d) =>
        d.external_id.split(':')[2] === type &&
        !this.retired.has(`${d.external_id}:${FEATURE.PRODUCTION_INDEX}`),
    );
    return (
      level.length > 0 &&
      !level.some((d) => {
        const id = `${d.external_id}:${FEATURE.PRODUCTION_INDEX}`;
        return (d.features ?? []).some((f) => f.external_id === id);
      })
    );
  }

  // --- /data -------------------------------------------------------------------------

  /** The feature external ids of every created device. */
  createdFeatureIds() {
    const set = new Set();
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        if (typeof feature?.external_id === 'string') set.add(feature.external_id);
      }
    }
    return set;
  }

  /**
   * Keeps the salt, the pace, the pause, the refusal, the guards and their
   * peaks, the retired indexes and the inverter totals in /data when they
   * changed. Never the state of an index of a created device nor a value
   * held is dropped (I5): only the entries of features no device has.
   */
  async saveState() {
    const indexes = {};
    for (const [id, guard] of this.guards) {
      indexes[id] = { guard: guard.state(), peaks: this.peaks.get(id) ?? [] };
    }
    const kept = keptIndexes(this.store.load().indexes);
    const created = this.createdFeatureIds();
    for (const [id, entry] of Object.entries(kept)) {
      if (id in indexes) continue;
      if (created.has(id) || isObject(entry.guard?.held) || this.retired.has(id)) {
        indexes[id] = entry;
      }
    }
    const entries = Object.entries(indexes);
    if (entries.length > MAX_KEPT_INDEXES) {
      this.logger.warn(`Hypontech: ${entries.length} index states, more than expected`);
    }
    const state = {
      salt: this.salt,
      pause: this.pause ?? null,
      refused: this.refused ?? null,
      lastAttemptAt: this.lastAttemptAt ?? null,
      indexLevel: this.indexLevel ?? null,
      // A retired index stays retired (B2) until its device is created again.
      retired: Object.fromEntries([...this.retired].slice(-MAX_KEPT_INDEXES)),
      inverterTotals: Object.fromEntries([...this.inverterTotals].slice(-MAX_KEPT_INDEXES)),
      indexes,
    };
    const key = JSON.stringify(state);
    if (key === this.savedKey) {
      return;
    }
    try {
      await this.store.save(state);
      this.savedKey = key;
    } catch (err) {
      this.logger.warn(`Saving the Hypontech state in /data failed (${err?.code ?? 'error'})`);
    }
  }

  // --- Devices -----------------------------------------------------------------------

  createdOf(externalId) {
    return (this.gladys.devices ?? []).find((d) => d.external_id === externalId);
  }

  /** The created devices of the last read. */
  createdDevices() {
    return this.devices()
      .map((d) => this.createdOf(d.external_id))
      .filter(Boolean);
  }

  /** The devices of the last read, each with the features of its created device kept. */
  devices() {
    if (!this.data) {
      return [];
    }
    const source = this.config.indexSource;
    const list = [];
    for (const { plant, inverters, batteries } of this.data.plants) {
      const caps = this.caps.get(plant.id) ?? { grid: false, load: false, battery: false };
      list.push(buildPlant(this.gladys, plant, { ...caps, index: source === 'plant' }));
      for (const inverter of inverters) {
        list.push(
          buildInverter(this.gladys, inverter, plant.id, { index: source === 'inverters' }),
        );
      }
      for (const battery of batteries) {
        list.push(buildBattery(this.gladys, battery, plant.id));
      }
    }
    // One device per external id (an inverter listed twice is one device).
    const seen = new Set();
    return list
      .filter((d) => (seen.has(d.external_id) ? false : seen.add(d.external_id)))
      .map((d) => keepCreatedFeatures(d, this.createdOf(d.external_id)));
  }

  /** Publishes the Discovery list when it changed (always after a start). */
  async discover() {
    if (!this.data || !this.session?.client) {
      return;
    }
    const devices = this.devices();
    const key = JSON.stringify(devices);
    if (key === this.discoveredKey) {
      return;
    }
    this.discoveredKey = key;
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.discoveredKey = undefined;
      this.logger.warn(`Publishing the Hypontech devices failed: ${err.message}`);
    });
  }

  /** The Discover tab asks: the known devices, never a read (the next one comes at its time). */
  async scan() {
    this.discoveredKey = undefined;
    await this.discover();
  }

  async onDeviceCreated(device) {
    const id = device?.external_id;
    if (typeof id !== 'string' || !this.devices().some((d) => d.external_id === id)) {
      return;
    }
    // A new device: no reference of its index yet (nor a state kept in /data
    // for a deleted device of the same id), and not retired: a device deleted
    // and created again starts afresh. Its values come at the next read.
    const indexId = `${id}:${FEATURE.PRODUCTION_INDEX}`;
    this.guards.delete(indexId);
    this.peaks.delete(indexId);
    this.outliers.delete(indexId);
    this.retired.delete(indexId);
    const kept = this.store.load();
    const indexes = keptIndexes(kept.indexes);
    delete indexes[indexId];
    const retired = isObject(kept.retired) ? { ...kept.retired } : {};
    delete retired[indexId];
    await this.store
      .save({ ...kept, indexes, retired })
      .catch((err) =>
        this.logger.warn(`Clearing the Hypontech index state failed (${err?.code ?? 'error'})`),
      );
    this.savedKey = undefined;
    this.discoveredKey = undefined;
    await this.updateStatus();
  }

  async onDeviceUpdated(device) {
    if (this.devices().some((d) => d.external_id === device?.external_id)) {
      this.discoveredKey = undefined;
      await this.updateStatus();
    }
  }

  // --- Values ------------------------------------------------------------------------

  /** The saved state of an index (`{ guard, peaks }`), read once. */
  savedIndex(id) {
    return keptIndexes(this.store.load().indexes)[id];
  }

  /** The power peaks of an index, from memory or /data. */
  peaksOf(id) {
    if (!this.peaks.has(id)) {
      this.peaks.set(id, validPeaks(this.savedIndex(id)?.peaks));
    }
    return this.peaks.get(id);
  }

  /**
   * The power of a read as a peak to learn, or undefined (zeversolar review
   * 2, m1): aberrant, never; above 1.5 x the typed peak (plant), never;
   * above 1.5 x the highest of the last 30 days (7 known), only when seen
   * twice in a row (then the lower of the two).
   */
  plausiblePeak(id, kind, power) {
    const previous = this.outliers.get(id);
    this.outliers.delete(id);
    const plausible = kind === 'plant' ? PLAUSIBLE_PLANT_W : PLAUSIBLE_INVERTER_W;
    if (!finite(power) || power <= 0 || power > plausible) {
      return undefined;
    }
    if (kind === 'plant' && finite(this.config.peakKw)) {
      return power > PEAK_OUTLIER * this.config.peakKw * 1000 ? undefined : power;
    }
    const peaks = this.peaksOf(id);
    if (peaks.length < PEAK_DAYS_MIN) {
      return power;
    }
    const top = PEAK_OUTLIER * Math.max(...peaks.map((p) => p.w));
    if (power <= top) {
      return power;
    }
    if (previous !== undefined) {
      return Math.min(previous, power);
    }
    this.outliers.set(id, power);
    return undefined;
  }

  /**
   * The margin of one read of an index (kW): the index's own (maxKwOf),
   * widened to 1.5 x the plausible power of that read when it is above it
   * (n1; never for a plant whose peak power is typed).
   */
  readMaxKw(id, kind, power) {
    const kw = maxKwOf(kind, this.config.peakKw, this.peaksOf(id));
    const plausible = kind === 'plant' ? PLAUSIBLE_PLANT_W : PLAUSIBLE_INVERTER_W;
    if (
      (kind === 'plant' && finite(this.config.peakKw)) ||
      !finite(power) ||
      power <= 0 ||
      power > plausible
    ) {
      return kw;
    }
    return Math.max(kw, clampKw((PEAK_OUTLIER * power) / 1000));
  }

  /** The guard of an index feature of a created device, from Gladys and /data, with this margin. */
  guardOf(created, id, maxKw) {
    const guard = this.guards.get(id);
    if (!guard) {
      const saved = this.savedIndex(id);
      this.guards.set(
        id,
        new IndexGuard(lastValueOf(created, id), saved?.guard, this.now(), {
          maxKw,
          slackKwh: INDEX_SLACK_KWH,
        }),
      );
    } else {
      guard.maxKw = maxKw;
    }
    return this.guards.get(id);
  }

  /**
   * The value of the index to send for a created device, through its guard:
   * the total when plausible, the last accepted one while a value is held,
   * else undefined. `source`: `{ kind: 'plant' | 'inverter', power, idle }`,
   * `usable`: false when this total must not reach the guard this time (a
   * plant total below its inverters, B1 c); `fresh` (default `usable`): the
   * source was read this time and is not stale, so at rest it re-dates its
   * reference even without a usable total.
   */
  indexFor(created, external, total, label, { kind, power, idle, usable = true, fresh = usable }) {
    const id = external.feature(FEATURE.PRODUCTION_INDEX);
    if (!(created.features ?? []).some((f) => f.external_id === id) || this.retired.has(id)) {
      return undefined;
    }
    const kw = this.readMaxKw(id, kind, power);
    const peak = this.plausiblePeak(id, kind, power);
    if (peak !== undefined) {
      this.peaks.set(id, withPeak(this.peaksOf(id), localDay(this.now()), peak));
    }
    const guard = this.guardOf(created, id, kw);
    this.labels.set(id, label);
    const value = usable ? totalOf(total) : undefined;
    const now = this.now();
    if (value === undefined) {
      if (fresh && idle && !guard.held && guard.last) {
        // At rest without a total (an offline inverter shown with 0, approval
        // 1, R1; a plant whose cloud sums the inverters online only, approval
        // 2, n1): the reference is dated now too. Never for a source stale or
        // not read (`fresh` false).
        guard.last = { value: guard.last.value, at: now };
      }
      return guard.held ? guard.last?.value : undefined;
    }
    if (idle && !guard.held && guard.last && value === guard.last.value) {
      // Nothing produced and nothing moved (the night): the reference is
      // dated now, the hours at rest never widen the margin of the next rise.
      guard.last = { value, at: now };
    }
    const plausible = guard.accept(value, now);
    if (!plausible && guard.held) {
      this.logger.warn(
        `Hypontech production index ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back`,
      );
    }
    // While a value is held, the last accepted one is sent again (no delta for the core).
    return plausible ? value : guard.held ? guard.last?.value : undefined;
  }

  /**
   * Whether the total of a plant may reach its guard (B1 c): its inverters
   * were read this time, and it reaches the sum of the highest totals seen
   * for them (rounding apart). Not while a listed inverter has no known
   * total yet (approval 1, R2: never a first reference from a partial sum).
   * A plant listing no inverter keeps the plain rule.
   */
  plantTotalUsable(entry) {
    if (!entry.invertersRead) {
      return false;
    }
    const inverters = entry.inverters;
    if (inverters.length === 0) {
      return true;
    }
    if (inverters.some((i) => !this.inverterTotals.has(i.sn))) {
      return false;
    }
    const sum = inverters.reduce((n, i) => n + this.inverterTotals.get(i.sn), 0);
    const total = totalOf(entry.plant.energyTotal);
    return (
      total !== undefined &&
      total >= sum - INDEX_SUM_PER_INVERTER * inverters.length - INDEX_SUM_SLACK
    );
  }

  /** Every state of the last read, the indexes through their guards. */
  async publishAll(gone) {
    const source = this.config.indexSource;
    const states = [];
    let plantIncomplete = 0;
    for (const entry of this.data.plants) {
      const { plant, monitor, inverters, batteries, stale } = entry;
      const external = ids(this.gladys, TYPES.PLANT, plant.id);
      const created = this.createdOf(external.device);
      if (created) {
        let index;
        if (source === 'plant') {
          const usable = this.plantTotalUsable(entry);
          if (!usable && finite(plant.energyTotal) && plant.energyTotal > 0) plantIncomplete += 1;
          index = this.indexFor(created, external, plant.energyTotal, plant.name || plant.id, {
            kind: 'plant',
            power: plant.power,
            idle: !(plant.power > 0),
            usable,
            // The plant list was just read: a plant at 0 W not stale is at
            // rest even when its total is not usable (approval 2, n1).
            fresh: !stale,
          });
        }
        states.push(
          ...this.allowed(created, plantStates(external, plant, monitor, index, { stale })),
        );
      }
      // The inverters of a plant the cloud did not update, or not read this
      // time: nothing of them is sent (never an old value as a new one).
      const fresh = entry.invertersRead && !stale;
      for (const inverter of inverters) {
        const ext = ids(this.gladys, TYPES.INVERTER, inverter.sn);
        const dev = this.createdOf(ext.device);
        if (!dev) continue;
        const index =
          source === 'inverters'
            ? this.indexFor(dev, ext, inverter.energyTotal, inverter.sn, {
                kind: 'inverter',
                power: inverter.online === 'offline' ? 0 : inverter.power,
                idle: inverter.online === 'offline' || !(inverter.power > 0),
                usable: fresh,
              })
            : undefined;
        const out = fresh
          ? inverterStates(ext, inverter, index)
          : index !== undefined
            ? inverterStates(ext, inverter, index).slice(0, 1)
            : [];
        states.push(...this.allowed(dev, out));
      }
      for (const battery of batteries) {
        const ext = ids(this.gladys, TYPES.BATTERY, battery.sn);
        const dev = this.createdOf(ext.device);
        if (dev && !stale) states.push(...this.allowed(dev, batteryStates(ext, battery)));
      }
    }
    this.notes.plantIncomplete = plantIncomplete;
    // The guards are in /data BEFORE Gladys gets the values: a crash in
    // between never sends an index /data does not know.
    await this.saveState();
    if (gone()) return;
    await this.publishStates(states, gone);
  }

  /** Only the features the created device has (they are fixed at its creation). */
  allowed(created, states) {
    const features = created.features ? new Set(created.features.map((f) => f.external_id)) : null;
    return features ? states.filter((s) => features.has(s.device_feature_external_id)) : states;
  }

  /** Room left in the budget of the last minute (all publications together). */
  room() {
    const mono = this.monotonic();
    this.sent = this.sent.filter((s) => mono - s.at < MINUTE);
    return STATES_PER_MINUTE - this.sent.reduce((n, s) => n + s.count, 0);
  }

  /**
   * The states sent within the budget of STATES_PER_MINUTE: the indexes
   * first, then the others; what does not fit waits for the next read
   * (publishChangedStates only counts what changed).
   */
  async publishStates(states, gone) {
    const isIndex = (s) => s.device_feature_external_id.endsWith(`:${FEATURE.PRODUCTION_INDEX}`);
    const queue = [...states.filter(isIndex), ...states.filter((s) => !isIndex(s))];
    while (queue.length > 0) {
      const room = this.room();
      if (room <= 0) {
        this.notes.budget = true;
        this.logger.warn(`Hypontech: ${queue.length} values left for the next read (budget)`);
        return;
      }
      const batch = queue.splice(0, room);
      let count = batch.length;
      try {
        const result = await this.gladys.publishChangedStates(batch, {
          heartbeat: STATE_HEARTBEAT,
        });
        count = Number.isInteger(result?.count) ? result.count : batch.length;
      } catch (err) {
        this.logger.warn(`Publishing the Hypontech values failed: ${err.message}`);
      }
      this.sent.push({ at: this.monotonic(), count });
      if (gone()) return;
    }
  }

  /** The indexes held back (never a retired one): `[{ id, label, direction, from, to, threshold }]`. */
  heldItems() {
    const items = [];
    for (const [id, guard] of this.guards) {
      if (guard.held && !this.retired.has(id)) {
        const { direction, from, to, threshold } = guard.held;
        items.push({ id, label: this.labels.get(id) ?? id, direction, from, to, threshold });
      }
    }
    return items;
  }

  // --- Configuration screen buttons -------------------------------------------------

  /**
   * "Accept the held index", in two clicks: the first lists the jumps held
   * and takes nothing; a second click within ACCEPT_CONFIRM_WITHIN takes
   * exactly the jumps listed (a value changed since stays held). Each taken
   * value is published at the next read (never a read sooner), bounded by
   * the guard (src/guard.js) to the value shown plus what may come meanwhile.
   * A DROP of a production total is never accepted (review 1, I1, as
   * gladys-zeversolar I2): it comes from an inverter offline, a partial
   * total or an odd value back to normal; taking it would count the climb
   * back twice. It corrects itself when the total comes back.
   */
  async acceptHeldIndex() {
    const held = this.heldItems();
    const jumps = held.filter((h) => h.direction === 'up');
    const drops = held.length - jumps.length;
    const mono = this.monotonic();
    const pending = this.pendingAccept;
    this.pendingAccept = undefined;
    if (pending && mono - pending.at <= ACCEPT_CONFIRM_WITHIN && pending.session === this.session) {
      const taken = [];
      let changed = 0;
      for (const item of pending.items) {
        const now = jumps.find((h) => h.id === item.id);
        const same =
          now && now.from === item.from && now.to === item.to && now.threshold === item.threshold;
        if (same && this.guards.get(item.id)?.acceptHeld()) {
          taken.push(item);
          this.logger.info('Hypontech production index jump accepted by the user');
        } else {
          changed += 1;
        }
      }
      return T.accept.done(taken, changed);
    }
    if (jumps.length === 0) {
      return drops > 0 ? T.accept.drop : T.accept.nothing;
    }
    this.pendingAccept = { at: mono, items: jumps, session: this.session };
    return T.accept.list(jumps, ACCEPT_CONFIRM_WITHIN, drops);
  }

  /**
   * The test button: never a read sooner than the pace allows. When a read
   * is due, this click makes it (refused credentials included: one try);
   * otherwise it tells the last one. The next read is scheduled when this
   * read ends, whatever the answer of the button (review 1, I3).
   */
  async testConnection() {
    if (!this.session?.client) {
      return T.incomplete;
    }
    if (this.pause && this.now() < this.pause.until) {
      return this.currentStatus()[1];
    }
    const refused = this.isRefused();
    const mono = this.monotonic();
    if (this.busy || this.dueAt(mono) > mono) {
      return refused
        ? T.test.refusedWait(Math.max(0, this.dueAt(mono) - mono))
        : this.describeOutcome();
    }
    const session = this.session;
    const run = this.tick({ retryRefused: refused }).finally(() => {
      if (this.running && session === this.session) this.schedule();
    });
    this.loopRun = run.catch(() => {});
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(T.test.slow), TEST_ANSWER_WITHIN);
    });
    try {
      return await Promise.race([
        run.then(() =>
          this.isRefused() ? T.refused(this.refused.status) : this.describeOutcome(),
        ),
        late,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** The last read in words, and the time to the next one. */
  describeOutcome() {
    const mono = this.monotonic();
    const next = Math.max(0, this.dueAt(mono) - mono);
    const outcome = this.outcome;
    if (!outcome) {
      return T.test.notYet(next);
    }
    const ago = Math.max(0, mono - outcome.at);
    if (outcome.kind === 'ok') {
      return T.test.reading(outcome.counts, ago, next);
    }
    return T.test.failed(outcome.err, ago, next);
  }
}

function freshNotes() {
  return { pages: [], truncated: false, skipped: 0, stale: 0, budget: false, plantIncomplete: 0 };
}
