// -----------------------------------------------------------------------------
// The Gladys devices of a Hypon cloud account and their states. Pure.
//
// External ids (forever): see TYPES in src/constants.js; feature keys
// (forever): see FEATURE below.
//
// Energy rules of the Gladys core (server/utils/constants.js and the
// energy-monitoring service), as in gladys-apsystems and gladys-zeversolar:
// - `production_index` is the ONLY energy-production-sensor / index feature:
//   the lifetime total the cloud gives (`e_total`), checked by the guard
//   (src/guard.js), never 0. It is declared on ONE level only, chosen in the
//   configuration (`index_source`): the plants (default), the inverters, or
//   none (another meter already counts the production): never both, the
//   production would be counted twice. Its `thirty-minutes-production`
//   feature is declared here (the core derives it), ids computed (UUID v5)
//   so an "Update" in Discovery keeps the same rows; never published by us;
// - `energy_today` is the counter of the day as the cloud gives it
//   (energy-production-sensor / daily-production): never an index;
// - powers: energy-production-sensor / power (production), grid-sensor /
//   power (the grid exchange, signed as the cloud gives it), energy-sensor /
//   power (the home's consumption, as the core says for a "load power");
// - the battery charge: battery-storage / battery-level (%);
// - units: only the ones the core lists for the category
//   (DEVICE_FEATURE_UNITS_BY_CATEGORY); none for unknown.
// Read-only: no feature is ever writable, no switch.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DAY_ENERGY_MAX, POWER_MAX, TYPES } from './constants.js';

/** Feature keys (forever). */
export const FEATURE = {
  POWER: 'power',
  ENERGY_TODAY: 'energy_today',
  PRODUCTION_INDEX: 'production_index',
  /** 30-minute production: fed by the Gladys core from the index, never by the integration. */
  PRODUCTION_30MIN: 'production_index_production',
  GRID_POWER: 'grid_power',
  LOAD_POWER: 'load_power',
  BATTERY_POWER: 'battery_power',
  BATTERY_LEVEL: 'battery_level',
  ONLINE: 'online',
  FAULT: 'fault',
  WARNING: 'warning',
  CYCLES: 'cycles',
};

/** The external ids of an item of a type (TYPES). */
export const ids = (gladys, type, id) => gladys.externalIds(type, id);

/** Namespace of the feature ids of this integration (random, fixed forever). */
const ID_NAMESPACE = Buffer.from('6c2e9b41d7a84f05b3e1c8d2a9f70e16', 'hex');

/** A deterministic UUID (version 5, RFC 9562) of a name (as gladys-apsystems). */
export function uuidOf(name) {
  const hash = createHash('sha1').update(ID_NAMESPACE).update(String(name), 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const feature = (external, key, name, category, type, extra = {}) => ({
  name,
  external_id: external.feature(key),
  category,
  type,
  min: 0,
  max: 1_000_000_000,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

/** A yes/no value shown, never summed (as the Livebox "internet" feature). */
const flag = (external, key, name) =>
  feature(external, key, name, C.UNKNOWN, T.SENSOR.BINARY, { max: 1 });

const productionPower = (external, name) =>
  feature(
    external,
    FEATURE.POWER,
    name,
    C.ENERGY_PRODUCTION_SENSOR,
    T.ENERGY_PRODUCTION_SENSOR.POWER,
    {
      unit: U.WATT,
      max: POWER_MAX,
    },
  );

const energyToday = (external, name) =>
  feature(
    external,
    FEATURE.ENERGY_TODAY,
    name,
    C.ENERGY_PRODUCTION_SENSOR,
    T.ENERGY_PRODUCTION_SENSOR.DAILY_PRODUCTION,
    { unit: U.KILOWATT_HOUR, max: DAY_ENERGY_MAX },
  );

/** The production index and its 30-minute production (fed by the core). */
const indexFeatures = (external, name) => {
  const indexId = external.feature(FEATURE.PRODUCTION_INDEX);
  return [
    feature(
      external,
      FEATURE.PRODUCTION_INDEX,
      name,
      C.ENERGY_PRODUCTION_SENSOR,
      T.ENERGY_PRODUCTION_SENSOR.INDEX,
      { id: uuidOf(indexId), unit: U.KILOWATT_HOUR },
    ),
    feature(
      external,
      FEATURE.PRODUCTION_30MIN,
      `${name} (30-minute production)`,
      C.ENERGY_PRODUCTION_SENSOR,
      T.ENERGY_PRODUCTION_SENSOR.THIRTY_MINUTES_PRODUCTION,
      {
        id: uuidOf(external.feature(FEATURE.PRODUCTION_30MIN)),
        energy_parent_id: uuidOf(indexId),
        unit: U.KILOWATT_HOUR,
      },
    ),
  ];
};

/**
 * The device of a plant. `plant`: src/hypon/model.js parsePlant. `caps`:
 * `{ index, grid, load, battery }`, what it carries (the index by the
 * configuration, the rest as the monitor showed it: only grows).
 */
export function buildPlant(gladys, plant, caps) {
  const external = ids(gladys, TYPES.PLANT, plant.id);
  const features = [
    productionPower(external, 'Solar production'),
    energyToday(external, 'Solar energy of the day'),
  ];
  if (caps.index) {
    features.push(...indexFeatures(external, 'Solar production index'));
  }
  if (caps.grid) {
    features.push(
      feature(
        external,
        FEATURE.GRID_POWER,
        'Grid power (import > 0, as the cloud gives it)',
        C.GRID_SENSOR,
        T.GRID_SENSOR.POWER,
        {
          unit: U.WATT,
          min: -POWER_MAX,
          max: POWER_MAX,
        },
      ),
    );
  }
  if (caps.load) {
    features.push(
      feature(
        external,
        FEATURE.LOAD_POWER,
        'Home consumption',
        C.ENERGY_SENSOR,
        T.ENERGY_SENSOR.POWER,
        {
          unit: U.WATT,
          max: POWER_MAX,
        },
      ),
    );
  }
  if (caps.battery) {
    features.push(
      feature(
        external,
        FEATURE.BATTERY_LEVEL,
        'Battery charge',
        C.BATTERY_STORAGE,
        T.BATTERY_STORAGE.BATTERY_LEVEL,
        { unit: U.PERCENT, max: 100 },
      ),
      feature(
        external,
        FEATURE.BATTERY_POWER,
        'Battery power (W, sign as the cloud gives it)',
        C.UNKNOWN,
        T.SENSOR.DECIMAL,
        { min: -POWER_MAX, max: POWER_MAX },
      ),
    );
  }
  return {
    name: plant.name ? `Hypontech ${plant.name}` : `Hypontech plant ${plant.id}`,
    external_id: external.device,
    features,
    params: [{ name: 'plant_id', value: plant.id }],
  };
}

/** The device of an inverter. `caps.index`: it carries the production index. */
export function buildInverter(gladys, inverter, plantId, caps) {
  const external = ids(gladys, TYPES.INVERTER, inverter.sn);
  const features = [
    productionPower(external, 'Solar production'),
    energyToday(external, 'Solar energy of the day'),
  ];
  if (caps.index) {
    features.push(...indexFeatures(external, 'Solar production index'));
  }
  features.push(
    flag(external, FEATURE.ONLINE, 'Inverter online (1 = online in the cloud)'),
    flag(external, FEATURE.FAULT, 'Inverter fault (1 = the cloud reports a fault)'),
    flag(external, FEATURE.WARNING, 'Inverter warning (1 = the cloud reports a warning)'),
  );
  const label = inverter.name || inverter.model || 'inverter';
  return {
    name: `Hypontech ${label} ${inverter.sn}`,
    external_id: external.device,
    features,
    params: [
      { name: 'serial', value: inverter.sn },
      { name: 'plant_id', value: plantId },
      { name: 'model', value: inverter.model },
      { name: 'software', value: inverter.software },
    ],
  };
}

/** The device of a battery. */
export function buildBattery(gladys, battery, plantId) {
  const external = ids(gladys, TYPES.BATTERY, battery.sn);
  return {
    name: `Hypontech battery ${battery.model ? `${battery.model} ` : ''}${battery.sn}`,
    external_id: external.device,
    features: [
      feature(
        external,
        FEATURE.BATTERY_LEVEL,
        'Battery charge',
        C.BATTERY_STORAGE,
        T.BATTERY_STORAGE.BATTERY_LEVEL,
        { unit: U.PERCENT, max: 100 },
      ),
      feature(external, FEATURE.CYCLES, 'Battery cycles', C.UNKNOWN, T.SENSOR.INTEGER),
    ],
    params: [
      { name: 'serial', value: battery.sn },
      { name: 'plant_id', value: plantId },
      { name: 'manufacturer', value: battery.manufacturer },
    ],
  };
}

/** What a feature declaration holds (a created feature also carries Gladys' own fields). */
const DECLARED = [
  'id',
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'energy_parent_id',
];

/**
 * A device republished in Discovery never loses a feature of the device the
 * user created (the core would mark it `structure_changed`, and "Update"
 * would delete that feature and its history): the features of the created
 * device that the new build lacks are kept as they are (gladys-apsystems).
 */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => f?.external_id && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return kept.length === 0 ? built : { ...built, features: [...built.features, ...kept] };
}

export const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const state = (external, key, value, digits) =>
  isNumber(value)
    ? [{ device_feature_external_id: external.feature(key), state: round(value, digits) }]
    : [];

const bit = (value) => (typeof value === 'boolean' ? (value ? 1 : 0) : undefined);

/** A value within [min, max], else undefined (a glitch, not sent). */
export const within = (value, max, min = 0) =>
  isNumber(value) && value >= min && value <= max ? value : undefined;

/** The index state: never 0 (the guard never lets 0 through, checked again here). */
const indexState = (external, index) =>
  isNumber(index) && index > 0 ? state(external, FEATURE.PRODUCTION_INDEX, index, 3) : [];

/**
 * The states of a plant. `index`: the value the guard let through
 * (undefined: not sent). `stale`: the cloud has not updated the plant for a
 * while: its power is not sent (never an old value as a new one).
 */
export function plantStates(external, plant, monitor, index, { stale = false } = {}) {
  return [
    ...indexState(external, index),
    ...(stale ? [] : state(external, FEATURE.POWER, within(plant.power, POWER_MAX), 0)),
    ...state(external, FEATURE.ENERGY_TODAY, within(plant.energyToday, DAY_ENERGY_MAX), 2),
    ...(monitor
      ? [
          ...state(
            external,
            FEATURE.GRID_POWER,
            within(monitor.gridPower, POWER_MAX, -POWER_MAX),
            0,
          ),
          ...state(external, FEATURE.LOAD_POWER, within(monitor.loadPower, POWER_MAX), 0),
          ...state(external, FEATURE.BATTERY_LEVEL, within(monitor.soc, 100), 0),
          ...state(
            external,
            FEATURE.BATTERY_POWER,
            within(monitor.batteryPower, POWER_MAX, -POWER_MAX),
            0,
          ),
        ]
      : []),
  ];
}

/**
 * The states of an inverter. Offline (the night for micro-inverters): its
 * power is 0, its counters are not sent (they keep their last value).
 */
export function inverterStates(external, inverter, index) {
  const offline = inverter.online === 'offline';
  return [
    ...indexState(external, index),
    ...state(external, FEATURE.POWER, offline ? 0 : within(inverter.power, POWER_MAX), 0),
    ...(offline
      ? []
      : state(external, FEATURE.ENERGY_TODAY, within(inverter.energyToday, DAY_ENERGY_MAX), 2)),
    ...state(external, FEATURE.ONLINE, inverter.online ? (offline ? 0 : 1) : undefined, 0),
    ...state(external, FEATURE.FAULT, bit(inverter.fault), 0),
    ...state(external, FEATURE.WARNING, bit(inverter.warning), 0),
  ];
}

export function batteryStates(external, battery) {
  return [
    ...state(external, FEATURE.BATTERY_LEVEL, within(battery.soc, 100), 0),
    ...state(external, FEATURE.CYCLES, within(battery.cycles, 1_000_000), 0),
  ];
}
