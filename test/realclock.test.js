// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local HTTP server playing the cloud (the account of the fake cloud,
// served over a real socket): the reads really start, at 0, the interval and
// twice the interval, with a bounded number of timers. The time is sped up
// 100 times (2 min of the interval are 1.2 s) but it is the real clock: it
// moves between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HyponApp } from '../src/app.js';
import { API_BASE, POLL_MIN_MIN } from '../src/constants.js';
import { HyponClient } from '../src/hypon/client.js';
import { createMemoryStore } from '../src/store.js';
import { PASSWORD, USERNAME, createCloud } from './helpers/fakeCloud.js';

const SPEED = 100;
const POLL_INTERVAL = POLL_MIN_MIN * 60_000;

test('real clock: reads at 0, the interval and twice the interval; timers bounded', async () => {
  const cloud = createCloud();
  const reads = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/v2/plant/list2') reads.push(performance.now() * SPEED);
    const answer = cloud.answer(url, req.method, {
      body,
      headers: { authorization: req.headers.authorization ?? '' },
    });
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(await answer.text());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // The client speaks to the cloud's host only: the test routes it to the local server.
  const local = (url, init) =>
    fetch(String(url).replace(API_BASE, `http://127.0.0.1:${port}/v2`), init);
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / SPEED);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  const gladys = createFakeGladys({ selector: 'hypontech', config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new HyponApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: () => Date.now() * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: createMemoryStore(),
    clientFactory: (options) => new HyponClient({ ...options, fetchImpl: local }),
  });
  const started = performance.now() * SPEED;
  try {
    await app.start({ username: USERNAME, password: PASSWORD, poll_minutes: POLL_MIN_MIN });
    // Counted from the first read (a cold start of fetch takes a few ms).
    const deadline = started + POLL_INTERVAL;
    while (reads.length === 0 && performance.now() * SPEED < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const until = (reads[0] ?? started) + 2.5 * POLL_INTERVAL;
    while (performance.now() * SPEED < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await app.stop();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const at = reads.map((t) => Math.round(t - started));
  assert.equal(reads.length, 3, `reads at ${at}`);
  assert.ok(reads[0] - started < 0.75 * POLL_INTERVAL, `the first read at once: ${at}`);
  for (let i = 1; i < reads.length; i += 1) {
    const gap = reads[i] - reads[i - 1];
    // Seen by the server: the latency of the requests before (a cold fetch
    // takes a few real ms, times SPEED, more on a loaded CI) may shorten the
    // gap seen here: wide margins.
    assert.ok(gap >= 0.7 * POLL_INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap < 1.5 * POLL_INTERVAL, `on time: ${at}`);
  }
  assert.ok(timersSet <= 20, `${timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
