// -----------------------------------------------------------------------------
// The answers of the cloud -> our values (src/hypon/model.js).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  idOf,
  num,
  onlineOf,
  pageOf,
  parseBattery,
  parseInverter,
  parseMonitor,
  parsePlant,
  str,
  timeOf,
} from '../src/hypon/model.js';

test('numbers: finite numbers and plain decimal texts only', () => {
  assert.equal(num(12.5), 12.5);
  assert.equal(num('97'), 97);
  assert.equal(num(' -150.5 '), -150.5);
  for (const bad of [NaN, Infinity, '', '1e9', '0x10', '12abc', null, undefined, {}, [], true]) {
    assert.equal(num(bad), undefined, String(bad));
  }
});

test('texts: short, printable, never an object', () => {
  assert.equal(str('Maison'), 'Maison');
  assert.equal(str('a\u0000b\u001bc\u007fd\u0085e'), 'abcde');
  assert.equal(str({ toString: () => 'x' }), '');
  assert.equal(str('x'.repeat(500)).length, 64);
  assert.equal(str(42), '42');
});

test('ids: letters, digits, _ and -, 1 to 64, else none', () => {
  assert.equal(idOf('HMS0001'), 'HMS0001');
  assert.equal(idOf(1001), '1001');
  for (const bad of ['', 'a/b', '../x', 'a b', 'x'.repeat(65), 1.5, null, '__proto__ ']) {
    assert.equal(idOf(bad), undefined, String(bad));
  }
});

test('dates: only with an offset (a local time would be hours off)', () => {
  assert.equal(timeOf('2026-06-06T06:58:18+01:00'), Date.parse('2026-06-06T05:58:18Z'));
  assert.equal(timeOf('2026-06-06T06:58:18Z'), Date.parse('2026-06-06T06:58:18Z'));
  assert.equal(timeOf('2026-06-06 06:58:18'), undefined);
  assert.equal(timeOf('yesterday'), undefined);
  assert.equal(timeOf(12), undefined);
});

test('status: online, offline, else unknown', () => {
  assert.equal(onlineOf('online'), 'online');
  assert.equal(onlineOf('Offline'), 'offline');
  assert.equal(onlineOf('fault'), undefined);
  assert.equal(onlineOf(''), undefined);
});

test('a page: its data array and a bounded page count', () => {
  assert.deepEqual(pageOf({ data: [1], totalPage: 3 }), { items: [1], totalPages: 3 });
  assert.deepEqual(pageOf({ data: [] }), { items: [], totalPages: 1 });
  assert.deepEqual(pageOf({ data: [], totalPage: -2 }), { items: [], totalPages: 1 });
  assert.equal(pageOf({ data: {} }), undefined);
  assert.equal(pageOf(null), undefined);
});

test('a plant: picked field by field, never without its id', () => {
  const plant = parsePlant({
    plant_id: '1001',
    plant_name: 'Maison',
    power: '640',
    e_today: 3.2,
    e_total: 1234.5,
    status: 'online',
    time: '2026-10-22T12:00:00+02:00',
    owner_name: 'never kept',
  });
  assert.deepEqual(plant, {
    id: '1001',
    name: 'Maison',
    power: 640,
    energyToday: 3.2,
    energyTotal: 1234.5,
    online: 'online',
    updatedAt: Date.parse('2026-10-22T10:00:00Z'),
  });
  assert.equal(parsePlant({ plant_name: 'x' }), undefined);
});

test('an inverter, a battery, a monitor', () => {
  const inverter = parseInverter({ sn: 'A1', model: 'HMS-800', fault: 2, warning: '0', power: 5 });
  assert.equal(inverter.fault, true);
  assert.equal(inverter.warning, false);
  assert.equal(inverter.power, 5);
  assert.equal(parseInverter({ sn: '' }), undefined);
  const battery = parseBattery({ sn: 'B1', soc: '97', ncyc: 12.5, battery_model: 'X' });
  assert.equal(battery.soc, 97);
  assert.equal(battery.cycles, undefined);
  assert.equal(battery.model, 'X');
  const monitor = parseMonitor({ meter_power: -150, power_load: 490, w_cha: 0, soc: 0 });
  assert.deepEqual(monitor.has, { grid: true, load: true, battery: false });
  assert.equal(parseMonitor({ soc: 40 }).has.battery, true);
  assert.equal(parseMonitor([]), undefined);
});

test('nothing of an answer reaches a prototype', () => {
  const evil = JSON.parse('{"__proto__": {"polluted": 1}, "plant_id": "1"}');
  const plant = parsePlant(evil);
  assert.equal(plant.id, '1');
  assert.equal({}.polluted, undefined);
  assert.equal(plant.polluted, undefined);
  // An inherited field is not read.
  const inherited = Object.create({ plant_id: 'x' });
  assert.equal(parsePlant(inherited), undefined);
});
