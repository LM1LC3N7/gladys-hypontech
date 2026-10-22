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
  MAX_KEPT_INDEXES,
  MAX_KW_MAX,
  MAX_KW_MIN,
  MAX_PLANTS,
  NO_BATTERY_RETRY,
  PAUSE_MAX,
  PAUSE_MIN,
  PLANT_STALE_AFTER,
  RETRY_MAX,
  STATE_HEARTBEAT,
  STATES_PER_MINUTE,
  TEST_ANSWER_WITHIN,
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
import { parseBattery, parseInverter, parsePlant } from './hypon/model.js';
import { createFileStore, credentialsHash } from './store.js';

const defaultTimers = { setTimeout, clearTimeout };
const MINUTE = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

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

/** The refusal read back from /data: `{ hash, at }`. */
const validRefused = (refused, now) =>
  refused && typeof refused.hash === 'string' && HEX64.test(refused.hash)
    ? { hash: refused.hash, at: finite(refused.at) ? Math.min(refused.at, now) : now }
    : undefined;

/** The index states kept in /data: plain objects under string keys only. */
function keptIndexes(indexes) {
  if (!indexes || typeof indexes !== 'object' || Array.isArray(indexes)) {
    return {};
  }
  const kept = {};
  for (const [key, value] of Object.entries(indexes)) {
    if (
      key !== '__proto__' &&
      key.length <= 200 &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      kept[key] = value;
    }
  }
  return kept;
}

/** The margin of the guard (kW): 1.25 x the peak power typed, else INDEX_MAX_KW. */
export function maxKwOf(peakKw) {
  if (!finite(peakKw)) {
    return INDEX_MAX_KW;
  }
  return Math.min(MAX_KW_MAX, Math.max(MAX_KW_MIN, Math.ceil(peakKw * 1.25 * 2) / 2));
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
    /** /data: salt, pace, pause, refusal, index guards. */
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
    /** By index feature external id: IndexGuard, and the label shown for it. */
    this.guards = new Map();
    this.labels = new Map();
    /** States sent to Gladys: `[{ at (monotonic), count }]`, the last minute. */
    this.sent = [];
    this.pendingAccept = undefined;
    this.resetReads();
  }

  /** What belongs to one account: forgotten when it changes. */
  resetReads() {
    /** The last read: `{ at (monotonic), kind: 'ok' | 'error', counts?, err? }`. */
    this.outcome = undefined;
    /** The last data read: `{ plants: [{ plant, monitor, inverters, batteries }] }`. */
    this.data = undefined;
    /** By plant id: what its monitor showed (`{ grid, load, battery }`), only grows. */
    this.caps = new Map();
    /** By plant id: monotonic time from which its batteries are asked again (none found). */
    this.batteryNextAt = new Map();
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    this.notes = { pages: [], truncated: false, skipped: 0, stale: 0, budget: false };
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
    if (config.indexSource !== this.config.indexSource) {
      // Another level for the index: the guards of the former one are no
      // longer shown (kept in /data, read back if that level comes back).
      this.guards.clear();
    }
    this.config = config;
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

  /** The monotonic time from which the next read may start (pace, retries, pause). */
  dueAt() {
    const mono = this.monotonic();
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
    const wait = Math.max(0, this.dueAt() - this.monotonic());
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
    if (mono < this.dueAt()) {
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
      if (plant) plants.push({ plant, monitor: undefined, inverters: [], batteries: [] });
      else notes.skipped += 1;
    }
    if (plants.length > MAX_PLANTS) {
      plants.length = MAX_PLANTS;
      notes.truncated = true;
    }
    // The secondary pages of each plant: a failure never holds back the
    // plant list; a 429 or 5xx of the account pauses the next ones.
    let stopped;
    for (const entry of plants) {
      if (stopped) break;
      const id = entry.plant.id;
      const pages = [
        ['monitor', () => client.readMonitor(id), (m) => (entry.monitor = m)],
        [
          'inverters',
          () => client.readInverters(id),
          (r) => this.collect(r, parseInverter, entry.inverters, notes),
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
        entry.batteries = this.previousBatteries(id);
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

  previousBatteries(plantId) {
    return this.data?.plants.find((p) => p.plant.id === plantId)?.batteries ?? [];
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
    }
    this.notes = {
      pages: [...notes.pages],
      truncated: notes.truncated,
      skipped: notes.skipped,
      stale,
      budget: false,
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
      this.refused = { hash: credentialsHash(this.salt, this.config), at: this.now() };
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
      return [false, T.refused];
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
      return [true, T.waiting(Math.max(0, this.dueAt() - this.monotonic()))];
    }
    if (this.data.plants.length === 0) {
      return [true, T.noPlant];
    }
    const extra = [];
    if (this.createdDevices().length === 0) extra.push(T.notes.noDevice);
    if (this.notes.pages.length > 0) extra.push(T.notes.pages(this.notes.pages));
    if (this.notes.truncated) extra.push(T.notes.truncated);
    if (this.notes.skipped > 0) extra.push(T.notes.skipped(this.notes.skipped));
    if (this.notes.stale > 0) extra.push(T.notes.stale(this.notes.stale));
    if (this.notes.budget) extra.push(T.notes.budget);
    if (this.config.indexSource === 'none') extra.push(T.notes.noIndex);
    return [true, T.ok(this.counts(), [...extra, ...notes])];
  }

  // --- /data -------------------------------------------------------------------------

  /** Keeps the salt, the pace, the pause, the refusal and the guards in /data when they changed. */
  async saveState() {
    const indexes = {};
    for (const [id, guard] of this.guards) {
      indexes[id] = { guard: guard.state() };
    }
    const kept = keptIndexes(this.store.load().indexes);
    for (const id of Object.keys(indexes)) delete kept[id];
    const merged = Object.entries({ ...kept, ...indexes }).slice(-MAX_KEPT_INDEXES);
    const state = {
      salt: this.salt,
      pause: this.pause ?? null,
      refused: this.refused ?? null,
      lastAttemptAt: this.lastAttemptAt ?? null,
      indexes: Object.fromEntries(merged),
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
    // for a deleted device of the same id). Its values come at the next read.
    const indexId = `${id}:${FEATURE.PRODUCTION_INDEX}`;
    this.guards.delete(indexId);
    const kept = this.store.load();
    const indexes = keptIndexes(kept.indexes);
    if (indexId in indexes) {
      delete indexes[indexId];
      await this.store
        .save({ ...kept, indexes })
        .catch((err) =>
          this.logger.warn(`Clearing the Hypontech index state failed (${err?.code ?? 'error'})`),
        );
      this.savedKey = undefined;
    }
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

  maxKw() {
    return maxKwOf(this.config.peakKw);
  }

  /** The guard of an index feature of a created device, from Gladys and /data. */
  guardOf(created, id) {
    const limits = { maxKw: this.maxKw(), slackKwh: INDEX_SLACK_KWH };
    const guard = this.guards.get(id);
    if (!guard) {
      const saved = keptIndexes(this.store.load().indexes)[id];
      this.guards.set(
        id,
        new IndexGuard(lastValueOf(created, id), saved?.guard, this.now(), limits),
      );
    } else if (guard.maxKw !== limits.maxKw) {
      // Another peak power typed: the same state, the new margin.
      this.guards.set(id, new IndexGuard(undefined, guard.state(), this.now(), limits));
    }
    return this.guards.get(id);
  }

  /**
   * The value of the index to send for a created device, through its guard:
   * the total when plausible, the last accepted one while a value is held,
   * else undefined. Only on the level the configuration chose.
   */
  indexFor(created, external, total, label) {
    const id = external.feature(FEATURE.PRODUCTION_INDEX);
    if (!(created.features ?? []).some((f) => f.external_id === id)) {
      return undefined;
    }
    const guard = this.guardOf(created, id);
    this.labels.set(id, label);
    const value = totalOf(total);
    if (value === undefined) {
      return undefined;
    }
    const plausible = guard.accept(value, this.now());
    if (!plausible && guard.held) {
      this.logger.warn(
        `Hypontech production index ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back: the "Accept the held index" button takes it`,
      );
    }
    // While a value is held, the last accepted one is sent again (no delta for the core).
    return plausible ? value : guard.held ? guard.last?.value : undefined;
  }

  /** Every state of the last read, the indexes through their guards. */
  async publishAll(gone) {
    const source = this.config.indexSource;
    const states = [];
    for (const { plant, monitor, inverters, batteries, stale } of this.data.plants) {
      const external = ids(this.gladys, TYPES.PLANT, plant.id);
      const created = this.createdOf(external.device);
      if (created) {
        const index =
          source === 'plant'
            ? this.indexFor(created, external, plant.energyTotal, plant.name || plant.id)
            : undefined;
        states.push(
          ...this.allowed(created, plantStates(external, plant, monitor, index, { stale })),
        );
      }
      for (const inverter of inverters) {
        const ext = ids(this.gladys, TYPES.INVERTER, inverter.sn);
        const dev = this.createdOf(ext.device);
        if (!dev) continue;
        const index =
          source === 'inverters'
            ? this.indexFor(dev, ext, inverter.energyTotal, inverter.sn)
            : undefined;
        states.push(...this.allowed(dev, inverterStates(ext, inverter, index)));
      }
      for (const battery of batteries) {
        const ext = ids(this.gladys, TYPES.BATTERY, battery.sn);
        const dev = this.createdOf(ext.device);
        if (dev) states.push(...this.allowed(dev, batteryStates(ext, battery)));
      }
    }
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

  /** The indexes held back, of the created devices: `[{ id, label, direction, from, to, threshold }]`. */
  heldItems() {
    const items = [];
    for (const [id, guard] of this.guards) {
      if (guard.held) {
        const { direction, from, to, threshold } = guard.held;
        items.push({ id, label: this.labels.get(id) ?? id, direction, from, to, threshold });
      }
    }
    return items;
  }

  // --- Configuration screen buttons -------------------------------------------------

  /**
   * "Accept the held index", in two clicks: the first lists the values held
   * and takes nothing; a second click within ACCEPT_CONFIRM_WITHIN takes
   * exactly the values listed (a value changed since stays held). Each taken
   * value is published at the next read (never a read sooner), bounded by
   * the guard (src/guard.js) to the value shown plus what may come meanwhile.
   * The total of the cloud is a counter of its own (not built from a counter
   * of the day): a drop accepted gives the core a negative delta, nothing
   * counted, as gladys-p1-monitor.
   */
  async acceptHeldIndex() {
    const held = this.heldItems();
    const mono = this.monotonic();
    const pending = this.pendingAccept;
    this.pendingAccept = undefined;
    if (pending && mono - pending.at <= ACCEPT_CONFIRM_WITHIN && pending.session === this.session) {
      const taken = [];
      let changed = 0;
      for (const item of pending.items) {
        const now = held.find((h) => h.id === item.id);
        const same =
          now &&
          now.direction === item.direction &&
          now.from === item.from &&
          now.to === item.to &&
          now.threshold === item.threshold;
        if (same && this.guards.get(item.id)?.acceptHeld()) {
          taken.push(item);
          this.logger.info(
            `Hypontech production index ${item.direction === 'down' ? 'drop' : 'jump'} accepted by the user`,
          );
        } else {
          changed += 1;
        }
      }
      return T.accept.done(taken, changed);
    }
    if (held.length === 0) {
      return T.accept.nothing;
    }
    this.pendingAccept = { at: mono, items: held, session: this.session };
    return T.accept.list(held, ACCEPT_CONFIRM_WITHIN);
  }

  /**
   * The test button: never a read sooner than the pace allows. When a read
   * is due, this click makes it (refused credentials included: one try);
   * otherwise it tells the last one.
   */
  async testConnection() {
    if (!this.session?.client) {
      return T.incomplete;
    }
    if (this.pause && this.now() < this.pause.until) {
      return this.currentStatus()[1];
    }
    const refused = this.isRefused();
    if (this.busy || this.dueAt() > this.monotonic()) {
      return refused
        ? T.test.refusedWait(Math.max(0, this.dueAt() - this.monotonic()))
        : this.describeOutcome();
    }
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(T.test.slow), TEST_ANSWER_WITHIN);
    });
    try {
      return await Promise.race([
        this.tick({ retryRefused: refused }).then(() =>
          this.isRefused() ? T.refused : this.describeOutcome(),
        ),
        late,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
      if (this.running) this.schedule();
    }
  }

  /** The last read in words, and the time to the next one. */
  describeOutcome() {
    const mono = this.monotonic();
    const next = Math.max(0, this.dueAt() - mono);
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
