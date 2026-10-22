// -----------------------------------------------------------------------------
// The answers of the Hypon cloud -> our values. Pure. The field names come
// from the hyponcloud library (models.py, see THIRD_PARTY_NOTICES.md); only
// the fields used here are read, each checked on its own: a number is a
// finite number or a plain decimal text ("97"), a text is short and printable.
// Nothing of an answer is ever spread into our objects (no prototype
// pollution): every value is picked by name from an own property.
// -----------------------------------------------------------------------------

import { ID_PATTERN, MAX_TEXT } from '../constants.js';

const own = (object, key) =>
  object !== null && typeof object === 'object' && Object.hasOwn(object, key)
    ? object[key]
    : undefined;

/** A number, or a plain decimal text; undefined otherwise. */
export function num(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,12}(\.\d{1,6})?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

/** A short printable text (control characters removed), '' otherwise. */
export function str(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return '';
  }
  const text = String(value).slice(0, 4 * MAX_TEXT);
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0)) {
      out += char;
    }
    if (out.length >= MAX_TEXT) break;
  }
  return out.trim();
}

/** An id usable in an external id (and in a URL path), undefined otherwise. */
export function idOf(value) {
  const text = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  return typeof text === 'string' && ID_PATTERN.test(text) ? text : undefined;
}

/**
 * A date of the cloud ("2026-06-06T06:58:18+01:00") in ms, undefined
 * otherwise. Only with its offset (or Z): a local time without one would be
 * read in the container's time zone, hours off.
 */
export function timeOf(value) {
  if (
    typeof value !== 'string' ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/i.test(value)
  ) {
    return undefined;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/** 'online' | 'offline' | undefined: the status texts the library shows. */
export function onlineOf(value) {
  const status = str(value).toLowerCase();
  if (status === 'online') return 'online';
  if (status === 'offline') return 'offline';
  return undefined;
}

/** A flag of the cloud (0 / non-zero), undefined when not a number. */
const flag = (value) => {
  const n = num(value);
  return n === undefined ? undefined : n !== 0;
};

/**
 * A page of a list: `{ items, totalPages }`. `items`: the `data` array;
 * `totalPages`: `totalPage` when it is a whole number from 1, else 1.
 * Undefined when the answer is not a page.
 */
export function pageOf(result) {
  const items = own(result, 'data');
  if (!Array.isArray(items)) {
    return undefined;
  }
  const total = num(own(result, 'totalPage'));
  return {
    items,
    totalPages: Number.isInteger(total) && total >= 1 ? total : 1,
  };
}

/** A plant of `plant/list2`; undefined without a usable `plant_id`. */
export function parsePlant(item) {
  const id = idOf(own(item, 'plant_id'));
  if (!id) {
    return undefined;
  }
  return {
    id,
    name: str(own(item, 'plant_name')),
    power: num(own(item, 'power')),
    energyToday: num(own(item, 'e_today')),
    energyTotal: num(own(item, 'e_total')),
    online: onlineOf(own(item, 'status')),
    updatedAt: timeOf(own(item, 'time')),
  };
}

/** An inverter of `plant/<id>/inverter`; undefined without a usable `sn`. */
export function parseInverter(item) {
  const sn = idOf(own(item, 'sn'));
  if (!sn) {
    return undefined;
  }
  return {
    sn,
    name: str(own(item, 'nick_name')),
    model: str(own(item, 'model')),
    software: str(own(item, 'software_version')),
    online: onlineOf(own(item, 'status')),
    power: num(own(item, 'power')),
    energyToday: num(own(item, 'e_today')),
    energyTotal: num(own(item, 'e_total')),
    fault: flag(own(item, 'fault')),
    warning: flag(own(item, 'warning')),
  };
}

/** A battery of `plant/<id>/battery`; undefined without a usable `sn`. */
export function parseBattery(item) {
  const sn = idOf(own(item, 'sn'));
  if (!sn) {
    return undefined;
  }
  const cycles = num(own(item, 'ncyc'));
  return {
    sn,
    model: str(own(item, 'model')) || str(own(item, 'battery_model')),
    manufacturer: str(own(item, 'manufacturer')),
    soc: num(own(item, 'soc')),
    cycles: Number.isInteger(cycles) ? cycles : undefined,
  };
}

/**
 * The monitor of a plant (`plant/<id>/monitor`, its `data`): the powers of
 * the grid, the home and the battery, and the battery charge. `has`: which
 * of them the answer carries (a micro-inverter plant may give none).
 */
export function parseMonitor(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }
  const gridPower = num(own(data, 'meter_power'));
  const loadPower = num(own(data, 'power_load'));
  const batteryPower = num(own(data, 'w_cha'));
  const soc = num(own(data, 'soc'));
  return {
    gridPower,
    loadPower,
    batteryPower,
    soc,
    has: {
      grid: gridPower !== undefined,
      load: loadPower !== undefined,
      // A battery: its charge or its power was ever above 0 (a plant without
      // battery gives 0 for both).
      battery: (soc !== undefined && soc > 0) || (batteryPower !== undefined && batteryPower !== 0),
    },
  };
}
