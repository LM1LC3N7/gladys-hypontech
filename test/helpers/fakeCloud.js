// -----------------------------------------------------------------------------
// A fake Hypon cloud: `fetch` answers the routes the client uses from a
// scripted account, records every call (never kept outside the test), and can
// hold the answers back (a slow cloud) until the test releases them.
// -----------------------------------------------------------------------------

export const USERNAME = 'solar@example.test';
export const PASSWORD = 'pa ss-w0rd!';
export const TOKEN = 'tok3n-abc.def';

const json = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** The error of AbortSignal.timeout. */
export const timeoutError = () => new DOMException('The operation timed out.', 'TimeoutError');

/** A default account: one plant, two micro-inverters, one battery. */
export function account() {
  return {
    username: USERNAME,
    password: PASSWORD,
    oem: 0,
    tokens: 0,
    plants: [
      {
        plant_id: '1001',
        plant_name: 'Maison',
        power: 640,
        e_today: 3.21,
        e_total: 1234.5,
        status: 'online',
        time: '2026-10-22T12:00:00+02:00',
      },
    ],
    inverters: {
      1001: [
        {
          sn: 'HMS0001',
          model: 'HMS-800',
          status: 'online',
          power: 320,
          e_today: 1.6,
          e_total: 600.25,
          fault: 0,
          warning: 0,
          software_version: '1.2',
        },
        {
          sn: 'HMS0002',
          model: 'HMS-800',
          status: 'online',
          power: 320,
          e_today: 1.61,
          e_total: 634.25,
          fault: 0,
          warning: 1,
        },
      ],
    },
    batteries: { 1001: [{ sn: 'BAT01', soc: '97', ncyc: 12, model: 'HB-5' }] },
    monitor: {
      1001: { meter_power: -150, power_load: 490, w_cha: 0, soc: 97, power_pv: 640 },
    },
  };
}

/**
 * `cloud.override(path, method)` may return a Response, 'timeout' or
 * undefined (the account answers).
 */
export function createCloud(data = account()) {
  const cloud = {
    data,
    calls: [],
    override: () => undefined,
    hold: false,
    held: [],
    release() {
      const held = cloud.held;
      cloud.held = [];
      for (const resolve of held) resolve();
    },
    count: (re) => cloud.calls.filter((c) => re.test(`${c.method} ${c.path}`)).length,
    async fetch(url, init = {}) {
      const parsed = new URL(url);
      const method = init.method ?? 'GET';
      const path = `${parsed.pathname}${parsed.search}`;
      const call = { host: parsed.host, method, path, init };
      cloud.calls.push(call);
      if (cloud.hold) {
        await new Promise((resolve) => cloud.held.push(resolve));
      }
      const special = cloud.override(path, method, init);
      if (special === 'timeout') throw timeoutError();
      if (special) return special;
      return cloud.answer(parsed, method, init);
    },
    answer(parsed, method, init) {
      const d = cloud.data;
      if (parsed.pathname === '/v2/login' && method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.username !== d.username || body.password !== d.password || body.oem !== d.oem) {
          return json(401, { message: 'invalid' });
        }
        d.tokens += 1;
        return json(200, { data: { token: `${TOKEN}${d.tokens}` } });
      }
      const auth = init.headers?.authorization ?? '';
      if (!auth.startsWith(`Bearer ${TOKEN}`) || auth !== `Bearer ${TOKEN}${d.tokens}`) {
        return json(401, { message: 'token' });
      }
      const page = Number(parsed.searchParams.get('page') ?? 1);
      const paged = (items, size = 10) =>
        json(200, {
          data: items.slice((page - 1) * size, page * size),
          totalPage: Math.max(1, Math.ceil(items.length / size)),
        });
      if (parsed.pathname === '/v2/plant/list2') {
        // The plant is updated now (the clock of the test), unless its `time` is frozen.
        const plants = d.plants.map((p) =>
          cloud.now && !d.frozenTime ? { ...p, time: new Date(cloud.now()).toISOString() } : p,
        );
        return paged(plants);
      }
      const m = /^\/v2\/plant\/([^/]+)\/(inverter|battery|monitor)$/.exec(parsed.pathname);
      if (m) {
        const [, id, what] = m;
        if (what === 'inverter') return paged(d.inverters[id] ?? []);
        if (what === 'battery') return paged(d.batteries[id] ?? []);
        return json(200, { data: d.monitor[id] ?? {} });
      }
      return json(404, { message: 'nope' });
    },
  };
  return cloud;
}

export const response = json;
