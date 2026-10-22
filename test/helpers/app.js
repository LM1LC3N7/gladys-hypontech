// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, the fake Hypon cloud and a virtual
// clock (the same for the wall clock and the monotonic one).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HyponApp } from '../../src/app.js';
import { buildBattery, buildInverter, buildPlant } from '../../src/devices.js';
import { HyponClient } from '../../src/hypon/client.js';
import { parseBattery, parseInverter, parsePlant } from '../../src/hypon/model.js';
import { createMemoryStore } from '../../src/store.js';
import { PASSWORD, USERNAME, account, createCloud } from './fakeCloud.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'hypontech';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const NOW = Date.parse('2026-10-22T10:05:00Z');
/** The account, the index on the plants (most scenarios); the default is each inverter. */
export const CONFIG = { username: USERNAME, password: PASSWORD, index_source: 'plant' };
export const INVERTERS = { ...CONFIG, index_source: 'inverters' };
export const F = (type, id, key) => `ext:${SELECTOR}:${type}:${id}:${key}`;
export const D = (type, id) => `ext:${SELECTOR}:${type}:${id}`;

const fakeExternal = createFakeGladys({ selector: SELECTOR });

/**
 * The devices as the user created them from the account `data`. `index`:
 * by device external id, `{ value, at }` Gladys holds for its index.
 * `source`: the level of the index at creation.
 */
export function created(data = account(), { source = 'plant', index = {}, monitorCaps } = {}) {
  const devices = [];
  for (const raw of data.plants) {
    const plant = parsePlant(raw);
    devices.push(
      buildPlant(fakeExternal, plant, {
        index: source === 'plant',
        ...(monitorCaps ?? { grid: true, load: true, battery: true }),
      }),
    );
    for (const inv of data.inverters[plant.id] ?? []) {
      devices.push(
        buildInverter(fakeExternal, parseInverter(inv), plant.id, {
          index: source === 'inverters',
        }),
      );
    }
    for (const bat of data.batteries[plant.id] ?? []) {
      devices.push(buildBattery(fakeExternal, parseBattery(bat), plant.id));
    }
  }
  for (const device of devices) {
    const held = index[device.external_id];
    if (held) {
      const feature = device.features.find((f) => f.external_id.endsWith(':production_index'));
      feature.last_value = held.value;
      feature.last_value_changed = new Date(held.at).toISOString();
    }
  }
  return devices;
}

export async function setup({
  devices = [],
  store = createMemoryStore(),
  now = NOW,
  cloud = createCloud(),
  config = CONFIG,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const { clock, timers, advance } = createFakeClock(now);
  cloud.now = () => clock.now;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new HyponApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.now,
    monotonic: () => clock.now,
    timers,
    store,
    clientFactory: (options) => new HyponClient({ ...options, fetchImpl: cloud.fetch }),
  });
  const start = async (cfg = config) => {
    await app.start(cfg);
    await advance(0);
    await app.idle();
  };
  const wait = async (ms) => {
    await advance(ms);
    await app.idle();
  };
  /** The states published for a feature, in order. */
  const statesOf = (id) =>
    gladys.fake.states.filter((s) => s.device_feature_external_id === id).map((s) => s.state);
  return { app, gladys, clock, store, cloud, start, wait, advance, lines, statesOf };
}
