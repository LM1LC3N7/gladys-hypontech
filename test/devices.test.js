// -----------------------------------------------------------------------------
// The devices (src/devices.js): core units only, the index on one level with
// its 30-minute production, nothing writable, never a lost feature.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBattery,
  buildInverter,
  buildPlant,
  inverterStates,
  keepCreatedFeatures,
  plantStates,
  uuidOf,
} from '../src/devices.js';

const gladys = {
  externalIds: (type, id) => ({
    device: `ext:hypontech:${type}:${id}`,
    feature: (key) => `ext:hypontech:${type}:${id}:${key}`,
  }),
};
const plant = { id: '1001', name: 'Maison' };
const inverter = { sn: 'HMS0001', model: 'HMS-800', name: '', software: '1.2' };
const battery = { sn: 'BAT01', model: 'HB-5', manufacturer: '' };
const ALL = { index: true, grid: true, load: true, battery: true };

/** The units the core lists for each category (DEVICE_FEATURE_UNITS_BY_CATEGORY). */
const UNITS = {
  'energy-production-sensor': ['watt', 'kilowatt', 'watt-hour', 'kilowatt-hour'],
  'energy-sensor': ['watt', 'kilowatt', 'watt-hour', 'kilowatt-hour'],
  'grid-sensor': ['watt', 'kilowatt', 'watt-hour', 'kilowatt-hour'],
  'battery-storage': ['percent', 'watt', 'kilowatt', 'watt-hour', 'kilowatt-hour'],
  unknown: [undefined],
};

test('core units only, nothing writable, never a switch', () => {
  const devices = [
    buildPlant(gladys, plant, ALL),
    buildInverter(gladys, inverter, '1001', { index: true }),
    buildBattery(gladys, battery, '1001'),
  ];
  for (const device of devices) {
    for (const feature of device.features) {
      assert.ok(UNITS[feature.category]?.includes(feature.unit), feature.external_id);
      assert.equal(feature.read_only, true);
      assert.notEqual(feature.category, 'switch');
    }
  }
});

test('the index and its 30-minute production, with stable ids', () => {
  const device = buildPlant(gladys, plant, ALL);
  const index = device.features.find((f) => f.type === 'index');
  const thirty = device.features.find((f) => f.type === 'thirty-minutes-production');
  assert.equal(index.id, uuidOf('ext:hypontech:plant:1001:production_index'));
  assert.equal(thirty.energy_parent_id, index.id);
  assert.match(index.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(device.features.filter((f) => f.type === 'index').length, 1);
  const without = buildPlant(gladys, plant, { ...ALL, index: false });
  assert.ok(
    !without.features.some((f) => f.category === 'energy-production-sensor' && f.type === 'index'),
  );
});

test('a created feature is never lost when the device is built again', () => {
  const createdDevice = buildPlant(gladys, plant, ALL);
  createdDevice.features[2].last_value = 12;
  const rebuilt = keepCreatedFeatures(buildPlant(gladys, plant, { index: false }), createdDevice);
  const ids = rebuilt.features.map((f) => f.external_id);
  for (const f of createdDevice.features) assert.ok(ids.includes(f.external_id), f.external_id);
  assert.ok(!rebuilt.features.some((f) => 'last_value' in f));
});

test('states: never an index of 0, an offline inverter at 0 W', () => {
  const external = gladys.externalIds('plant', '1001');
  const values = { power: 10, energyToday: 1, energyTotal: 0 };
  assert.ok(
    !plantStates(external, values, undefined, 0).some(
      (s) => s.state === 0 && s.device_feature_external_id.endsWith('index'),
    ),
  );
  const out = inverterStates(gladys.externalIds('inverter', 'X'), {
    online: 'offline',
    power: 300,
    energyToday: 2,
  });
  assert.deepEqual(
    out.map((s) => [s.device_feature_external_id.split(':').pop(), s.state]),
    [
      ['power', 0],
      ['online', 0],
    ],
  );
});

test('names fall back to the ids when the cloud gives none', () => {
  assert.equal(buildPlant(gladys, { id: '7' }, {}).name, 'Hypontech plant 7');
  assert.equal(buildInverter(gladys, { sn: 'S1' }, '7', {}).name, 'Hypontech inverter S1');
});
