// -----------------------------------------------------------------------------
// The scenarios of review 1 (B1, B2, I1 to I5, m2, m6) against the fake
// Gladys and the fake cloud: what the core would count from the published
// index (every rise in full, drops skipped) never exceeds what was produced.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { PASSWORD, account, createCloud, response } from './helpers/fakeCloud.js';
import { CONFIG, D, F, HOUR, INVERTERS, MINUTE, NOW, created, setup } from './helpers/app.js';

const PLANT = D('plant', '1001');
const INDEX = F('plant', '1001', 'production_index');
const INV1 = F('inverter', 'HMS0001', 'production_index');
const statusOf = (s) => s.gladys.fake.connectionStatus.message.en;

/** What the core counts from the published values of an index: every rise, from `start`. */
function counted(values, start) {
  let last = start;
  let sum = 0;
  for (const v of values) {
    if (v > last) sum += v - last;
    last = v;
  }
  return Math.round(sum * 1000) / 1000;
}

const round = (v) => Math.round(v * 1000) / 1000;

/** The night: nothing produced, the micro-inverters offline (their totals kept). */
function night(d) {
  d.plants[0].power = 0;
  for (const inv of d.inverters['1001']) {
    inv.status = 'offline';
    inv.power = 0;
  }
}

/** The day: each inverter produces `kwh`, the plant total is their sum. */
function produce(d, kwh) {
  for (const inv of d.inverters['1001']) {
    inv.status = 'online';
    inv.power = 320;
    inv.e_total = round(inv.e_total + kwh);
  }
  d.plants[0].power = 640;
  d.plants[0].e_total = round(d.inverters['1001'].reduce((n, i) => n + i.e_total, 0));
}

const withIndex = (source = 'plant', value = 1234.5) =>
  created(account(), {
    source,
    index:
      source === 'plant'
        ? { [PLANT]: { value, at: NOW - MINUTE } }
        : {
            [D('inverter', 'HMS0001')]: { value: 600.25, at: NOW - MINUTE },
            [D('inverter', 'HMS0002')]: { value: 634.25, at: NOW - MINUTE },
          },
  });

test('B1 b (Z1): a night never widens the margin of the morning; an odd total is held', async () => {
  const cloud = createCloud();
  night(cloud.data);
  const s = await setup({ devices: withIndex(), cloud });
  await s.start();
  // Six hours of night, then one odd total at 03:00-like time.
  for (let i = 0; i < 72; i += 1) await s.wait(5 * MINUTE);
  cloud.data.plants[0].e_total = 1834.5;
  await s.wait(5 * MINUTE);
  assert.match(statusOf(s), /held back.*1234\.5 -> 1834\.5/);
  cloud.data.plants[0].e_total = 1234.5;
  await s.wait(5 * MINUTE);
  // The first read of the morning carries the odd value again: held too.
  produce(cloud.data, 0.01);
  cloud.data.plants[0].e_total = 1834.5;
  await s.wait(5 * MINUTE);
  assert.match(statusOf(s), /held back/);
  // Then a normal morning.
  let real = 0;
  cloud.data.plants[0].e_total = 1234.52;
  real += 0.02;
  for (let i = 0; i < 12; i += 1) {
    produce(cloud.data, 0.02);
    real += 0.04;
    await s.wait(5 * MINUTE);
  }
  const total = counted(s.statesOf(INDEX), 1234.5);
  assert.ok(total <= round(real) + 0.001, `counted ${total}, real ${round(real)}`);
  assert.ok(total >= round(real) - 0.1, `counted ${total}, real ${round(real)}`);
});

test('B1 c (Z2): a plant total of the inverters online only is never counted', async () => {
  const cloud = createCloud();
  night(cloud.data);
  // The cloud sums the inverters online only: at night, one of them.
  cloud.data.plants[0].e_total = 634.25;
  const s = await setup({ devices: created(), cloud });
  await s.start();
  for (let i = 0; i < 24; i += 1) await s.wait(5 * MINUTE);
  assert.deepEqual(s.statesOf(INDEX), [], 'no first reference from a partial total');
  assert.match(statusOf(s), /below the sum of their inverters/);
  // Morning: every inverter back, the total complete.
  let real = 0;
  for (let i = 0; i < 12; i += 1) {
    produce(cloud.data, 0.02);
    if (i > 0) real += 0.04;
    // One inverter still offline now and then: its share missing from the plant total.
    if (i % 4 === 3) cloud.data.plants[0].e_total = round(cloud.data.plants[0].e_total - 600);
    await s.wait(5 * MINUTE);
  }
  const values = s.statesOf(INDEX);
  assert.equal(values[0], 1234.54);
  assert.ok(counted(values, values[0]) <= round(real) + 0.001);
  assert.doesNotMatch(statusOf(s), /held back/);
});

test('I1 (Z2b): a drop of a production index is never accepted', async () => {
  const cloud = createCloud();
  const s = await setup({ devices: withIndex('inverters'), cloud, config: INVERTERS });
  await s.start();
  cloud.data.inverters['1001'][0].e_total = 500;
  await s.wait(5 * MINUTE);
  assert.match(statusOf(s), /a drop: never accepted/);
  const first = await s.app.acceptHeldIndex();
  assert.match(first.en, /never accepted/);
  const second = await s.app.acceptHeldIndex();
  assert.match(second.en, /never accepted/);
  cloud.data.inverters['1001'][0].e_total = 600.3;
  await s.wait(5 * MINUTE);
  assert.ok(counted(s.statesOf(INV1), 600.25) <= 0.051);
  assert.doesNotMatch(statusOf(s), /held back/);
});

test('B1 (Z3): an inverter added at night (its own total) is held on the plant, never counted silently', async () => {
  const cloud = createCloud();
  night(cloud.data);
  const s = await setup({ devices: withIndex(), cloud });
  await s.start();
  for (let i = 0; i < 12; i += 1) await s.wait(5 * MINUTE);
  cloud.data.inverters['1001'].push({ sn: 'HMS0003', status: 'offline', power: 0, e_total: 300 });
  cloud.data.plants[0].e_total = 1534.5;
  await s.wait(5 * MINUTE);
  assert.ok(s.statesOf(INDEX).every((v) => v === 1234.5));
  assert.match(statusOf(s), /held back.*1234\.5 -> 1534\.5/);
});

test('B1 (Z8): a gateway offline for 3 h, then its catch-up, counted once and right', async () => {
  const cloud = createCloud();
  const s = await setup({ devices: withIndex(), cloud });
  await s.start();
  cloud.data.frozenTime = true;
  cloud.data.plants[0].time = new Date(NOW).toISOString();
  for (let i = 0; i < 36; i += 1) await s.wait(5 * MINUTE);
  cloud.data.frozenTime = false;
  produce(cloud.data, 0.96);
  await s.wait(5 * MINUTE);
  assert.equal(s.statesOf(INDEX).at(-1), 1236.42);
  assert.equal(counted(s.statesOf(INDEX), 1234.5), 1.92);
});

test('B2 (Z4): an index of a level left never receives values again, even when it comes back', async () => {
  const store = createMemoryStore();
  const cloud = createCloud();
  const devices = withIndex('plant');
  const s = await setup({ devices, cloud, store });
  await s.start();
  assert.deepEqual(s.statesOf(INDEX), [1234.5]);
  await s.start(INVERTERS);
  for (let i = 0; i < 24; i += 1) {
    produce(cloud.data, 0.5);
    await s.wait(5 * MINUTE);
  }
  await s.start(CONFIG);
  for (let i = 0; i < 6; i += 1) {
    produce(cloud.data, 0.01);
    await s.wait(5 * MINUTE);
  }
  assert.ok(
    s.statesOf(INDEX).every((v) => v === 1234.5),
    'never fed again',
  );
  assert.match(statusOf(s), /production index of 1 device\(s\) was stopped/);
  // Only "delete and create it again", never "Update" too (approval 1, r3).
  assert.doesNotMatch(statusOf(s), /click "Update"/);
  assert.ok(INDEX in store.data.retired);
  // A restart keeps it retired; via "none" too.
  await s.app.stop();
  const again = await setup({ devices, cloud, store, now: s.clock.now });
  await again.start(CONFIG);
  await again.wait(10 * MINUTE);
  assert.deepEqual(again.statesOf(INDEX), []);
  // Deleted and created again: afresh, from its current total.
  const plant = again.gladys.fake.discoveredDevices.find((d) => d.external_id === PLANT);
  await again.gladys.fake.deviceCreated(plant);
  await again.app.onDeviceCreated(plant);
  await again.wait(5 * MINUTE);
  assert.equal(again.statesOf(INDEX).length, 1);
  assert.ok(!(INDEX in store.data.retired));
});

test('I2 (Z9): an 800 W inverter: +5 kWh in one read held; its learned margin is narrower', async () => {
  const cloud = createCloud();
  const s = await setup({ devices: withIndex('inverters'), cloud, config: INVERTERS });
  await s.start();
  cloud.data.inverters['1001'][0].e_total = 605.25;
  await s.wait(5 * MINUTE);
  assert.ok(s.statesOf(INV1).every((v) => v === 600.25));
  assert.match(statusOf(s), /held back.*HMS0001: 600\.25 -> 605\.25/);
  // With a week of peaks at 800 W: 1.5 kW, +2 kWh in 5 min is held too.
  const week = Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-1${i}`, w: 800 }));
  const store = createMemoryStore({
    indexes: { [INV1]: { guard: { last: { value: 600.25, at: NOW }, held: null }, peaks: week } },
  });
  const cloud2 = createCloud();
  const t = await setup({
    devices: withIndex('inverters'),
    cloud: cloud2,
    config: INVERTERS,
    store,
  });
  await t.start();
  cloud2.data.inverters['1001'][0].e_total = 602.25;
  await t.wait(5 * MINUTE);
  assert.ok(t.statesOf(INV1).every((v) => v === 600.25));
  // A plausible rise of an 800 W inverter goes through.
  cloud2.data.inverters['1001'][0].e_total = 600.32;
  await t.wait(5 * MINUTE);
  assert.equal(t.statesOf(INV1).at(-1), 600.32);
});

test('I5 (Z7): the state of every created index and every held value stays in /data', async () => {
  const data = account();
  data.inverters['1001'] = Array.from({ length: 70 }, (_, i) => ({
    sn: `INV${String(i).padStart(3, '0')}`,
    status: 'online',
    power: 100,
    e_total: 100 + i,
  }));
  data.plants[0].e_total = data.inverters['1001'].reduce((n, i) => n + i.e_total, 0);
  const cloud = createCloud(data);
  const store = createMemoryStore();
  const s = await setup({
    devices: created(data, { source: 'inverters' }),
    cloud,
    config: INVERTERS,
    store,
  });
  await s.start();
  data.inverters['1001'][0].e_total = 1000;
  await s.wait(5 * MINUTE);
  const id = F('inverter', 'INV000', 'production_index');
  assert.equal(Object.keys(store.data.indexes).length, 70);
  assert.equal(store.data.indexes[id].guard.held.to, 1000);
});

test('I3 (P4): a slow test click after a refusal: the reads go on afterwards', async () => {
  const cloud = createCloud();
  cloud.data.password = 'changed';
  const s = await setup({ cloud });
  await s.start();
  assert.match(statusOf(s), /refused the login/);
  cloud.data.password = PASSWORD;
  await s.advance(10 * MINUTE);
  cloud.hold = true;
  const answer = s.app.testConnection();
  await new Promise((resolve) => setImmediate(resolve));
  await s.advance(21_000);
  assert.match((await answer).en, /slow to answer/);
  cloud.hold = false;
  cloud.release();
  await s.app.idle();
  await s.wait(3 * HOUR);
  assert.ok(cloud.count(/list2/) >= 30, `${cloud.count(/list2/)} reads`);
});

test('I4: any 4xx at login but 408 and 429 is a final refusal', async () => {
  for (const status of [400, 404, 422]) {
    const store = createMemoryStore();
    const cloud = createCloud();
    cloud.override = (path) => (path === '/v2/login' ? response(status, {}) : undefined);
    const s = await setup({ cloud, store });
    await s.start();
    await s.wait(6 * HOUR);
    assert.equal(cloud.count(/login/), 1, String(status));
    assert.match(statusOf(s), new RegExp(`refused the login \\(HTTP ${status}\\)`));
    assert.notEqual(store.data.refused, null);
  }
  const cloud = createCloud();
  cloud.override = (path) => (path === '/v2/login' ? response(408, {}) : undefined);
  const s = await setup({ cloud });
  await s.start();
  assert.doesNotMatch(statusOf(s), /refused the login/);
});

test('m2: a failed inverters page keeps them known, sends nothing of them, no plant total', async () => {
  const cloud = createCloud();
  const s = await setup({ devices: withIndex(), cloud });
  await s.start();
  const before = s.gladys.fake.states.length;
  cloud.override = (path) => (path.includes('/inverter') ? response(502, {}) : undefined);
  produce(cloud.data, 0.01);
  await s.wait(5 * MINUTE);
  assert.match(statusOf(s), /2 inverter\(s\)/);
  assert.match(statusOf(s), /Not read this time: inverters/);
  const after = s.gladys.fake.states.slice(before).map((st) => st.device_feature_external_id);
  assert.ok(!after.some((id) => id.includes(':inverter:')));
  assert.ok(!after.includes(INDEX) || s.statesOf(INDEX).at(-1) === 1234.5);
});

test('m6 and the default: the index on each inverter; a created inverter without it is said', async () => {
  const s = await setup({ config: { username: CONFIG.username, password: PASSWORD } });
  await s.start({ username: CONFIG.username, password: PASSWORD });
  const inverter = s.gladys.fake.discoveredDevices.find(
    (d) => d.external_id === D('inverter', 'HMS0001'),
  );
  assert.ok(inverter.features.some((f) => f.type === 'index'));
  const t = await setup({ devices: created(account(), { source: 'plant' }), config: INVERTERS });
  await t.start(INVERTERS);
  assert.match(statusOf(t), /None of the created inverters carries the production index/);
});

test('approval 1, R1 (Z1i): an offline inverter shown with a total of 0 at night: the morning margin stays short', async () => {
  const cloud = createCloud();
  const s = await setup({ devices: withIndex('inverters'), cloud, config: INVERTERS });
  await s.start();
  // Thirteen hours of night, the cloud showing 0 for the offline inverters.
  night(cloud.data);
  for (const inv of cloud.data.inverters['1001']) inv.e_total = 0;
  for (let i = 0; i < 156; i += 1) await s.wait(5 * MINUTE);
  // 06:05: one odd read, +40 kWh on HMS0001.
  Object.assign(cloud.data.inverters['1001'][0], { status: 'online', power: 50, e_total: 640.25 });
  await s.wait(5 * MINUTE);
  assert.ok(
    s.statesOf(INV1).every((v) => v === 600.25),
    String(s.statesOf(INV1)),
  );
  assert.match(statusOf(s), /held back.*HMS0001: 600\.25 -> 640\.25/);
  // Back to its real total: it goes on, nothing counted twice.
  cloud.data.inverters['1001'][0].e_total = 600.27;
  await s.wait(5 * MINUTE);
  assert.ok(counted(s.statesOf(INV1), 600.25) <= 0.021);
});

test('approval 1, R2 (Z2z): a plant total is not used while an inverter has no known total', async () => {
  const cloud = createCloud();
  night(cloud.data);
  for (const inv of cloud.data.inverters['1001']) inv.e_total = 0;
  cloud.data.plants[0].e_total = 0;
  const s = await setup({ devices: created(), cloud });
  await s.start();
  for (let i = 0; i < 12; i += 1) await s.wait(5 * MINUTE);
  // Dawn: one inverter online, the other still offline at 0, the plant = the online one.
  Object.assign(cloud.data.inverters['1001'][0], { status: 'online', power: 50, e_total: 600.3 });
  cloud.data.plants[0].e_total = 600.3;
  cloud.data.plants[0].power = 50;
  for (let i = 0; i < 6; i += 1) await s.wait(5 * MINUTE);
  assert.deepEqual(s.statesOf(INDEX), [], 'never a first reference from a partial sum');
  assert.match(statusOf(s), /below the sum of their inverters/);
  // The second one comes online: the whole total, the first reference.
  Object.assign(cloud.data.inverters['1001'][1], { status: 'online', power: 50, e_total: 634.3 });
  cloud.data.plants[0].e_total = 1234.6;
  await s.wait(5 * MINUTE);
  assert.deepEqual(s.statesOf(INDEX), [1234.6]);
  assert.doesNotMatch(statusOf(s), /held back/);
});

for (const odd of [40, 300]) {
  test(`approval 2, n1 (Z11): plant level, the cloud summing the inverters online only: +${odd} kWh at 06:20 held`, async () => {
    const cloud = createCloud();
    const s = await setup({ devices: withIndex(), cloud });
    await s.start();
    // Thirteen hours of night: nothing online, the plant total at 0 (not usable).
    night(cloud.data);
    cloud.data.plants[0].e_total = 0;
    for (let i = 0; i < 156; i += 1) await s.wait(5 * MINUTE);
    // 06:20: one inverter online, one odd plant total on this read only.
    Object.assign(cloud.data.inverters['1001'][0], { status: 'online', power: 50, e_total: 600.3 });
    cloud.data.plants[0].power = 50;
    cloud.data.plants[0].e_total = round(1234.55 + odd);
    await s.wait(5 * MINUTE);
    assert.ok(
      s.statesOf(INDEX).every((v) => v === 1234.5),
      String(s.statesOf(INDEX)),
    );
    assert.match(statusOf(s), /held back/);
    // Then the morning as it is: nothing counted twice.
    Object.assign(cloud.data.inverters['1001'][1], { status: 'online', power: 50, e_total: 634.3 });
    cloud.data.plants[0].e_total = 1234.6;
    await s.wait(5 * MINUTE);
    assert.ok(counted(s.statesOf(INDEX), 1234.5) <= 0.101);
  });
}
