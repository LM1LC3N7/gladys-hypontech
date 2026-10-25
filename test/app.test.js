// -----------------------------------------------------------------------------
// The integration against the fake Gladys and the fake Hypon cloud: devices,
// values, the index and its guard, the pace, the refusal, the pauses, late
// answers, the budget and what /data keeps.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { maxKwOf } from '../src/app.js';
import { PASSWORD, USERNAME, account, createCloud, response } from './helpers/fakeCloud.js';
import { CONFIG, D, F, HOUR, MINUTE, NOW, created, setup } from './helpers/app.js';

const PLANT = D('plant', '1001');
const INDEX = F('plant', '1001', 'production_index');
const statusOf = (s) => s.gladys.fake.connectionStatus;

test('first read: the plant, its inverters and its battery offered in Discovery', async () => {
  const s = await setup();
  await s.start();
  const ids = s.gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.deepEqual(ids, [
    PLANT,
    D('inverter', 'HMS0001'),
    D('inverter', 'HMS0002'),
    D('battery', 'BAT01'),
  ]);
  const plant = s.gladys.fake.discoveredDevices[0];
  const types = plant.features.map((f) => `${f.category}/${f.type}`);
  assert.deepEqual(types, [
    'energy-production-sensor/power',
    'energy-production-sensor/daily-production',
    'energy-production-sensor/index',
    'energy-production-sensor/thirty-minutes-production',
    'grid-sensor/power',
    'energy-sensor/power',
    'battery-storage/battery-level',
    'unknown/decimal',
  ]);
  // The index on the plants only (the default): never on the inverters too.
  const inverter = s.gladys.fake.discoveredDevices[1];
  assert.ok(!inverter.features.some((f) => f.type === 'index'));
  assert.equal(statusOf(s).connected, true);
  assert.match(statusOf(s).message.en, /1 plant\(s\), 2 inverter\(s\), 1 battery/);
  assert.match(statusOf(s).message.en, /Discover/);
  assert.equal(s.gladys.fake.states.length, 0, 'no value before a device is created');
});

test('created devices: their values, the index of the cloud through the guard', async () => {
  const s = await setup({ devices: created() });
  await s.start();
  assert.deepEqual(s.statesOf(INDEX), [1234.5]);
  assert.deepEqual(s.statesOf(F('plant', '1001', 'power')), [640]);
  assert.deepEqual(s.statesOf(F('plant', '1001', 'energy_today')), [3.21]);
  assert.deepEqual(s.statesOf(F('plant', '1001', 'grid_power')), [-150]);
  assert.deepEqual(s.statesOf(F('plant', '1001', 'load_power')), [490]);
  assert.deepEqual(s.statesOf(F('plant', '1001', 'battery_level')), [97]);
  assert.deepEqual(s.statesOf(F('inverter', 'HMS0002', 'warning')), [1]);
  assert.deepEqual(s.statesOf(F('battery', 'BAT01', 'battery_level')), [97]);
  assert.deepEqual(s.statesOf(F('battery', 'BAT01', 'cycles')), [12]);
  assert.deepEqual(s.statesOf(F('inverter', 'HMS0001', 'production_index')), []);
  assert.deepEqual(s.statesOf(F('plant', '1001', 'production_index_production')), []);
  assert.doesNotMatch(statusOf(s).message.en, /Discover/);
});

test('the index: never 0, a jump held until two clicks, then exactly that value', async () => {
  const s = await setup({
    devices: created(account(), { index: { [PLANT]: { value: 1234.5, at: NOW - MINUTE } } }),
  });
  s.cloud.data.plants[0].e_total = 0;
  await s.start();
  assert.deepEqual(s.statesOf(INDEX), [], 'never 0');
  // A jump of 5000 kWh in 5 minutes: held, the last accepted value sent instead.
  s.cloud.data.plants[0].e_total = 6234.5;
  await s.wait(5 * MINUTE);
  assert.deepEqual(s.statesOf(INDEX), [1234.5]);
  assert.match(statusOf(s).message.en, /held back.*1234\.5 -> 6234\.5 kWh/);
  // Repeated for hours: never confirmed by time nor repetition.
  for (let i = 0; i < 24; i += 1) await s.wait(5 * MINUTE);
  assert.ok(s.statesOf(INDEX).every((v) => v === 1234.5));
  // First click: the list, nothing accepted.
  const first = await s.app.acceptHeldIndex();
  assert.match(first.en, /Nothing accepted yet/);
  // The test clock drifts by microseconds per read of the monotonic clock:
  // the second click comes well within the 5 min, never at their edge.
  await s.wait(4 * MINUTE);
  assert.ok(s.statesOf(INDEX).every((v) => v === 1234.5));
  // Second click within 5 min: exactly the value listed.
  const second = await s.app.acceptHeldIndex();
  assert.match(second.en, /Accepted: Maison: 1234\.5 -> 6234\.5 kWh/);
  await s.wait(5 * MINUTE);
  assert.equal(s.statesOf(INDEX).at(-1), 6234.5);
  assert.doesNotMatch(statusOf(s).message.en, /held back/);
});

test('a second click never takes a value that changed since the list', async () => {
  const s = await setup({
    devices: created(account(), { index: { [PLANT]: { value: 1234.5, at: NOW - MINUTE } } }),
  });
  s.cloud.data.plants[0].e_total = 6234.5;
  await s.start();
  // The first click a minute after the read: the next read (at 5 min) comes
  // before the second click, well within the 5 min of the window.
  await s.wait(MINUTE);
  await s.app.acceptHeldIndex();
  s.cloud.data.plants[0].e_total = 9234.5;
  await s.wait(4 * MINUTE);
  const second = await s.app.acceptHeldIndex();
  assert.match(second.en, /Nothing accepted\. 1 value\(s\) changed/);
  await s.wait(5 * MINUTE);
  assert.ok(s.statesOf(INDEX).every((v) => v === 1234.5));
  // Too late: a click after 5 min is a first click again.
  await s.app.acceptHeldIndex();
  await s.advance(6 * MINUTE);
  const late = await s.app.acceptHeldIndex();
  assert.match(late.en, /Nothing accepted yet/);
  // Saving the configuration accepts nothing.
  await s.start(CONFIG);
  await s.wait(5 * MINUTE);
  assert.ok(s.statesOf(INDEX).every((v) => v === 1234.5));
});

test('a held index survives a restart (kept in /data)', async () => {
  const store = createMemoryStore();
  const devices = created(account(), { index: { [PLANT]: { value: 1234.5, at: NOW - MINUTE } } });
  const cloud = createCloud();
  cloud.data.plants[0].e_total = 6234.5;
  const s = await setup({ devices, store, cloud });
  await s.start();
  await s.app.stop();
  const again = await setup({ devices, store, cloud, now: NOW + 10 * MINUTE });
  await again.start();
  await again.wait(5 * MINUTE);
  assert.ok(again.statesOf(INDEX).every((v) => v === 1234.5));
  assert.match(statusOf(again).message.en, /held back/);
});

test('index on the inverters: the plant has none, never both levels counted', async () => {
  const devices = created(account(), { source: 'inverters' });
  const s = await setup({ devices, config: { ...CONFIG, index_source: 'inverters' } });
  await s.start();
  assert.deepEqual(s.statesOf(F('inverter', 'HMS0001', 'production_index')), [600.25]);
  assert.deepEqual(s.statesOf(F('inverter', 'HMS0002', 'production_index')), [634.25]);
  assert.deepEqual(s.statesOf(INDEX), []);
  const plant = s.gladys.fake.discoveredDevices.find((d) => d.external_id === PLANT);
  assert.ok(!plant.features.some((f) => f.type === 'index'));
});

test('a plant device created with the index keeps it (never a lost feature), fed no more', async () => {
  const devices = created(account(), { source: 'plant' });
  const s = await setup({ devices, config: { ...CONFIG, index_source: 'none' } });
  await s.start();
  const plant = s.gladys.fake.discoveredDevices.find((d) => d.external_id === PLANT);
  assert.ok(plant.features.some((f) => f.external_id === INDEX));
  assert.deepEqual(s.statesOf(INDEX), []);
  assert.match(statusOf(s).message.en, /another meter counts/);
});

test('the pace: never two reads less than an interval apart, whatever asks', async () => {
  const store = createMemoryStore();
  const cloud = createCloud();
  const s = await setup({ store, cloud });
  await s.start();
  const lists = () => cloud.count(/list2/);
  assert.equal(lists(), 1);
  // A reconnection, a save of the same form, the Discover tab, the test button.
  await s.start();
  await s.start(CONFIG);
  await s.app.scan();
  const test1 = await s.app.testConnection();
  assert.match(test1.en, /Read now|Last read/);
  await s.wait(MINUTE);
  assert.equal(lists(), 1);
  // A restart of the container: the time of the last read is in /data.
  await s.app.stop();
  const again = await setup({ store, cloud, now: NOW + 2 * MINUTE });
  await again.start();
  assert.equal(lists(), 1);
  await again.wait(2 * MINUTE);
  assert.equal(lists(), 1);
  await again.wait(MINUTE + 1000);
  assert.equal(lists(), 2);
});

test('refused credentials: final, kept in /data, never tried again by themselves', async () => {
  const store = createMemoryStore();
  const cloud = createCloud();
  const wrong = { username: USERNAME, password: 'wrong' };
  const s = await setup({ store, cloud, config: wrong });
  await s.start(wrong);
  assert.equal(statusOf(s).connected, false);
  assert.match(statusOf(s).message.en, /refused the login/);
  await s.wait(3 * HOUR);
  assert.equal(cloud.count(/login/), 1);
  // A restart: still refused, nothing sent.
  await s.app.stop();
  const again = await setup({ store, cloud, config: wrong, now: NOW + 3 * HOUR });
  await again.start(wrong);
  await again.wait(HOUR);
  assert.equal(cloud.count(/login/), 1);
  assert.match(statusOf(again).message.en, /refused the login/);
  // The test button: one more try (spaced), still refused.
  const tried = await again.app.testConnection();
  assert.match(tried.en, /refused the login/);
  assert.equal(cloud.count(/login/), 2);
  const soon = await again.app.testConnection();
  assert.match(soon.en, /One more try is possible in/);
  assert.equal(cloud.count(/login/), 2);
  // The right password saved: read at its time, the refusal erased by the login.
  await again.start(CONFIG);
  await again.wait(5 * MINUTE);
  assert.equal(cloud.count(/login/), 3);
  assert.equal(statusOf(again).connected, true);
  assert.equal(store.data.refused, null);
  // Never the password, the username or a token in /data.
  const kept = JSON.stringify(store.data);
  assert.ok(!kept.includes(PASSWORD) && !kept.includes('wrong') && !kept.includes(USERNAME));
  assert.ok(!kept.includes('tok3n'));
});

test('the test button erases a refusal only after a login that works', async () => {
  const store = createMemoryStore();
  const cloud = createCloud();
  cloud.data.password = 'other';
  const s = await setup({ store, cloud });
  await s.start();
  assert.match(statusOf(s).message.en, /refused the login/);
  // The account's password is changed back on the portal; a network error first.
  cloud.data.password = PASSWORD;
  cloud.override = () => 'timeout';
  await s.advance(5 * MINUTE);
  await s.app.testConnection();
  assert.notEqual(store.data.refused, null);
  cloud.override = () => undefined;
  await s.advance(5 * MINUTE);
  await s.app.testConnection();
  assert.equal(store.data.refused, null);
  assert.equal(statusOf(s).connected, true);
});

test('429: a bounded pause kept in /data, a restart does not end it', async () => {
  const store = createMemoryStore();
  const cloud = createCloud();
  cloud.override = (path) =>
    path.includes('list2') ? response(429, {}, { 'retry-after': '999999' }) : undefined;
  const s = await setup({ store, cloud });
  await s.start();
  assert.match(statusOf(s).message.en, /asks to wait.*6 h/);
  assert.equal(store.data.pause.until, NOW + 6 * HOUR);
  await s.app.stop();
  const again = await setup({ store, cloud, now: NOW + HOUR });
  await again.start();
  await again.wait(4 * HOUR);
  assert.equal(cloud.count(/list2/), 1);
  cloud.override = () => undefined;
  await again.wait(HOUR + MINUTE);
  assert.equal(cloud.count(/list2/), 2);
  assert.equal(statusOf(again).connected, true);
  assert.equal(store.data.pause, null);
});

test('a 5xx of a secondary page never holds back the plant', async () => {
  const cloud = createCloud();
  cloud.override = (path) => (path.includes('/monitor') ? response(502, {}) : undefined);
  const s = await setup({ devices: created(), cloud });
  await s.start();
  assert.deepEqual(s.statesOf(INDEX), [1234.5]);
  assert.deepEqual(s.statesOf(F('plant', '1001', 'grid_power')), []);
  assert.equal(statusOf(s).connected, true);
  assert.match(statusOf(s).message.en, /Not read this time: grid and battery/);
});

test('a late answer of a former account publishes nothing and sets no status', async () => {
  const cloud = createCloud();
  const s = await setup({ devices: created(), cloud });
  cloud.hold = true;
  await s.app.start(CONFIG);
  // The read starts and waits for the cloud (not awaited: it is held).
  const running = s.advance(0);
  for (let i = 0; i < 20 && cloud.held.length === 0; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cloud.calls.length, 1, 'the login is on its way');
  // The account changes while the read waits for the cloud.
  const statuses = s.gladys.fake.connectionStatuses.length;
  await s.app.start({ username: 'other@example.test', password: 'x' });
  cloud.hold = false;
  cloud.release();
  await running;
  await s.app.idle();
  assert.equal(s.gladys.fake.states.length, 0);
  assert.equal(s.gladys.fake.discoveredDevices.length, 0);
  const after = s.gladys.fake.connectionStatuses.slice(statuses);
  assert.ok(after.every((st) => !/Connected to the Hypon cloud/.test(st.message?.en ?? '')));
});

test('one login per hour of reads; a token ended early, one login', async () => {
  const cloud = createCloud();
  const s = await setup({ cloud });
  await s.start();
  for (let i = 0; i < 10; i += 1) await s.wait(5 * MINUTE);
  assert.equal(cloud.count(/login/), 1);
  for (let i = 0; i < 2; i += 1) await s.wait(5 * MINUTE);
  assert.equal(cloud.count(/login/), 2, 'renewed before the hour ends');
  cloud.data.tokens += 1;
  await s.wait(5 * MINUTE);
  assert.equal(cloud.count(/login/), 3);
  assert.equal(statusOf(s).connected, true);
});

test('an offline inverter: power 0, its counters not sent', async () => {
  const cloud = createCloud();
  cloud.data.inverters['1001'][0].status = 'offline';
  const s = await setup({ devices: created(), cloud });
  await s.start();
  assert.deepEqual(s.statesOf(F('inverter', 'HMS0001', 'power')), [0]);
  assert.deepEqual(s.statesOf(F('inverter', 'HMS0001', 'online')), [0]);
  assert.deepEqual(s.statesOf(F('inverter', 'HMS0001', 'energy_today')), []);
});

test('a stale plant: no live value, no energy of the day, nothing of its inverters (m3)', async () => {
  const cloud = createCloud();
  cloud.data.frozenTime = true;
  cloud.data.plants[0].time = '2026-10-22T08:00:00+02:00';
  const s = await setup({ devices: created(), cloud });
  await s.start();
  assert.deepEqual(s.statesOf(F('plant', '1001', 'power')), []);
  assert.deepEqual(s.statesOf(F('plant', '1001', 'energy_today')), []);
  assert.deepEqual(s.statesOf(F('inverter', 'HMS0001', 'power')), []);
  assert.deepEqual(s.statesOf(F('battery', 'BAT01', 'battery_level')), []);
  assert.deepEqual(s.statesOf(INDEX), [1234.5]);
  assert.match(statusOf(s).message.en, /not updated by the cloud for more than 2 h/);
});

test('never more than 280 values a minute, the indexes first', async () => {
  const data = account();
  data.inverters['1001'] = Array.from({ length: 60 }, (_, i) => ({
    sn: `INV${String(i).padStart(3, '0')}`,
    status: 'online',
    power: 100 + i,
    e_today: 1 + i,
    e_total: 100 + i,
    fault: 0,
    warning: 0,
  }));
  const cloud = createCloud(data);
  const s = await setup({
    devices: created(data, { source: 'inverters' }),
    cloud,
    config: { ...CONFIG, index_source: 'inverters' },
  });
  await s.start();
  const sent = s.gladys.fake.states.length;
  assert.ok(sent <= 280, `${sent} states`);
  const indexes = s.gladys.fake.states.filter((st) =>
    st.device_feature_external_id.endsWith(':production_index'),
  );
  assert.equal(indexes.length, 60);
  assert.match(statusOf(s).message.en, /at most 280 values a minute/);
  await s.wait(5 * MINUTE);
  assert.ok(s.statesOf(F('inverter', 'INV059', 'warning')).length > 0, 'the rest at the next read');
});

test('a new device starts its index afresh; items without an id are counted, not guessed', async () => {
  const cloud = createCloud();
  cloud.data.inverters['1001'].push({ sn: '../etc', power: 1 });
  const store = createMemoryStore({
    indexes: { [INDEX]: { guard: { last: { value: 99999, at: NOW - HOUR }, held: null } } },
  });
  const s = await setup({ cloud, store });
  await s.start();
  assert.match(statusOf(s).message.en, /1 item\(s\) without a usable identifier/);
  const plant = s.gladys.fake.discoveredDevices.find((d) => d.external_id === PLANT);
  await s.gladys.fake.deviceCreated(plant);
  await s.app.onDeviceCreated(plant);
  assert.equal(store.data.indexes[INDEX], undefined);
  await s.wait(5 * MINUTE);
  assert.deepEqual(s.statesOf(INDEX), [1234.5]);
});

test('the margin of the guard: one per index, typed, learned, bounded (I2)', () => {
  const week = (w) => Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-0${i + 1}`, w }));
  assert.equal(maxKwOf('plant', undefined), 60);
  assert.equal(maxKwOf('plant', 3), 4);
  assert.equal(maxKwOf('plant', 3, week(800)), 4, 'typed wins for a plant');
  assert.equal(maxKwOf('plant', undefined, week(2400)), 4);
  assert.equal(maxKwOf('plant', undefined, week(2400).slice(1)), 60, 'not 7 days yet');
  assert.equal(maxKwOf('plant', 1000), 1250);
  assert.equal(maxKwOf('inverter', undefined), 15);
  assert.equal(maxKwOf('inverter', 3), 4);
  assert.equal(maxKwOf('inverter', 3, week(800)), 1.5, 'its own power wins');
  assert.equal(maxKwOf('inverter', undefined, week(100)), 0.5);
});

test('an incomplete form: no request, the status says what to enter', async () => {
  const cloud = createCloud();
  const s = await setup({ cloud, config: {} });
  await s.start({});
  await s.wait(HOUR);
  assert.equal(cloud.calls.length, 0);
  assert.match(statusOf(s).message.en, /Enter the username and the password/);
  assert.match(String(await s.app.testConnection().then((t) => t.en)), /Enter the username/);
});
