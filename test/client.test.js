// -----------------------------------------------------------------------------
// The only network access (src/hypon/client.js): the login, the token, the
// bounds, the errors in our words.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HyponClient, HyponError, parseJson } from '../src/hypon/client.js';
import { PASSWORD, USERNAME, createCloud, response } from './helpers/fakeCloud.js';

const HOUR = 3_600_000;

function clientOf(cloud, extra = {}) {
  const clock = { now: Date.parse('2026-10-22T10:00:00Z') };
  const client = new HyponClient({
    username: USERNAME,
    password: PASSWORD,
    oem: 0,
    fetchImpl: cloud.fetch,
    now: () => clock.now,
    ...extra,
  });
  return { client, clock };
}

test('login: a JSON POST with the account and the portal, never a redirect followed', async () => {
  const cloud = createCloud();
  let logins = 0;
  const { client } = clientOf(cloud, { onLogin: () => (logins += 1) });
  client.beginRead();
  const { items } = await client.readPlants();
  assert.equal(items.length, 1);
  const login = cloud.calls[0];
  assert.equal(login.host, 'api.hypon.cloud');
  assert.equal(login.path, '/v2/login');
  assert.equal(login.method, 'POST');
  assert.deepEqual(JSON.parse(login.init.body), { username: USERNAME, password: PASSWORD, oem: 0 });
  assert.equal(login.init.redirect, 'manual');
  assert.equal(login.init.headers['user-agent'], undefined, 'no User-Agent of ours');
  const get = cloud.calls[1];
  assert.equal(get.path, '/v2/plant/list2?page=1&page_size=10&refresh=true');
  assert.match(get.init.headers.authorization, /^Bearer /);
  assert.equal(get.init.redirect, 'manual');
  assert.equal(logins, 1);
});

test('the password and the token are never in a JSON nor an inspection of the client', async () => {
  const cloud = createCloud();
  const { client } = clientOf(cloud);
  client.beginRead();
  await client.readPlants();
  const shown = JSON.stringify(client) + Object.keys(client).join();
  assert.ok(!shown.includes(PASSWORD));
  assert.ok(!shown.includes('tok3n'));
});

test('the token is kept for the hour, renewed 5 min before its end', async () => {
  const cloud = createCloud();
  const { client, clock } = clientOf(cloud);
  client.beginRead();
  await client.readPlants();
  clock.now += 50 * 60_000;
  client.beginRead();
  await client.readPlants();
  assert.equal(cloud.count(/login/), 1);
  clock.now += 6 * 60_000;
  client.beginRead();
  await client.readPlants();
  assert.equal(cloud.count(/login/), 2);
  clock.now += HOUR;
});

test('a 401 on a GET with an older token: one login, one new try, never more', async () => {
  const cloud = createCloud();
  const { client } = clientOf(cloud);
  client.beginRead();
  await client.readPlants();
  cloud.data.tokens += 1; // the token ends early
  client.beginRead();
  await client.readPlants();
  assert.equal(cloud.count(/login/), 2);
  // The cloud refuses every token: one login in the read, then an error, no loop.
  cloud.override = (path, method) =>
    method === 'GET' ? response(401, { message: 'no' }) : undefined;
  client.beginRead();
  await assert.rejects(client.readPlants(), { code: 'unauthorized' });
  assert.equal(cloud.count(/login/), 3);
  client.beginRead();
  // The token of this read is fresh: no second login within a read.
  await assert.rejects(client.readPlants(), { code: 'unauthorized' });
  assert.equal(cloud.count(/login/), 4);
});

test('refused credentials are final: 401, 403, or no token', async () => {
  for (const answer of [
    response(401, {}),
    response(403, {}),
    response(200, { data: {} }),
    response(200, { data: { token: 'bad token with spaces' } }),
  ]) {
    const cloud = createCloud();
    cloud.override = (path) => (path === '/v2/login' ? answer : undefined);
    const { client } = clientOf(cloud);
    client.beginRead();
    const err = await client.readPlants().catch((e) => e);
    assert.ok(err instanceof HyponError);
    assert.equal(err.code, 'refused');
    assert.equal(err.final, true);
    assert.ok(!err.message.includes(PASSWORD));
  }
});

test('429 and 5xx in our words, with Retry-After; 3xx never followed', async () => {
  const cloud = createCloud();
  const { client } = clientOf(cloud);
  cloud.override = () => response(429, {}, { 'retry-after': '120' });
  client.beginRead();
  await assert.rejects(client.readPlants(), { code: 'rate_limited', retryAfter: 120_000 });
  cloud.override = () => response(503, {});
  await assert.rejects(client.login(), { code: 'server', status: 503 });
  cloud.override = () =>
    new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } });
  await assert.rejects(client.login(), { code: 'redirect' });
  cloud.override = () => 'timeout';
  await assert.rejects(client.login(), { code: 'timeout' });
  cloud.override = () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  await assert.rejects(client.login(), { code: 'unreachable' });
});

test('answers bounded in size, parsed without prototype keys', async () => {
  const cloud = createCloud();
  const { client } = clientOf(cloud);
  cloud.override = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
        },
      }),
      { status: 200 },
    );
  await assert.rejects(client.login(), { code: 'too_large' });
  cloud.override = () => response(200, 'not json');
  await assert.rejects(client.login(), { code: 'bad_answer' });
  const parsed = parseJson('{"__proto__":{"x":1},"constructor":{"y":2},"a":{"prototype":3,"b":4}}');
  assert.deepEqual(Object.keys(parsed), ['a']);
  assert.deepEqual(Object.keys(parsed.a), ['b']);
  assert.equal({}.x, undefined);
});

test('lists: every page up to 10, an odd page refused', async () => {
  const cloud = createCloud();
  cloud.data.plants = Array.from({ length: 25 }, (_, i) => ({ plant_id: `P${i}` }));
  const { client } = clientOf(cloud);
  client.beginRead();
  const { items, truncated } = await client.readPlants();
  assert.equal(items.length, 25);
  assert.equal(truncated, false);
  assert.equal(cloud.count(/list2/), 3);
  cloud.data.plants = Array.from({ length: 150 }, (_, i) => ({ plant_id: `P${i}` }));
  client.beginRead();
  const long = await client.readPlants();
  assert.equal(long.items.length, 100);
  assert.equal(long.truncated, true);
  cloud.override = (path) => (path.includes('list2') ? response(200, { data: 'x' }) : undefined);
  client.beginRead();
  await assert.rejects(client.readPlants(), { code: 'bad_answer' });
});

test('the plant id is encoded in the paths', async () => {
  const cloud = createCloud();
  const { client } = clientOf(cloud);
  client.beginRead();
  await client.readInverters('1001');
  await client.readBatteries('1001');
  const monitor = await client.readMonitor('1001');
  assert.equal(monitor.gridPower, -150);
  assert.deepEqual(
    cloud.calls.slice(1).map((c) => c.path),
    [
      '/v2/plant/1001/inverter?page=1',
      '/v2/plant/1001/battery?page=1&page_size=10',
      '/v2/plant/1001/monitor?refresh=true',
    ],
  );
});
