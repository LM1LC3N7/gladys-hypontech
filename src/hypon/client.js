// -----------------------------------------------------------------------------
// The only network access: the Hypon cloud (https://api.hypon.cloud/v2), as
// the hyponcloud library reads it (see THIRD_PARTY_NOTICES.md):
// - POST /login {username, password, oem} -> data.token (valid 1 h);
// - GET with "authorization: Bearer <token>": plant/list2 (paged),
//   plant/<id>/inverter, plant/<id>/battery (paged), plant/<id>/monitor.
// Read-only: nothing else is ever sent. Node's own fetch: no User-Agent of
// ours, no imitation of an app, no key of an app.
//
// Bounded: one request at a time, 10 s for the whole answer (the body
// included), 256 KiB at most read into one buffer allocated once, never a
// redirect followed (the password and the token never go elsewhere), at most
// MAX_PAGES pages per list. The library's retries (3 x 10 s) are NOT ported:
// one try per read, the app paces the reads.
//
// The token: kept in memory only, renewed 5 min before its end, at most one
// login per read (`beginRead`): a 401 on a GET with an older token gives one
// login and one new try, never more; a 401 again is an error of the read,
// never a loop.
//
// Errors carry our own codes, never a text of the cloud, a URL, the username,
// the password nor the token.
// -----------------------------------------------------------------------------

import {
  API_BASE,
  HTTP_TIMEOUT,
  MAX_BODY_BYTES,
  MAX_PAGES,
  TOKEN_MARGIN,
  TOKEN_VALIDITY,
} from '../constants.js';
import { pageOf, parseMonitor } from './model.js';

export class HyponError extends Error {
  /**
   * @param {'timeout'|'unreachable'|'http'|'not_found'|'server'|'rate_limited'|'too_large'|
   *   'redirect'|'bad_answer'|'refused'|'unauthorized'|'forbidden'} code
   * `refused`: the login was refused (401/403, or no token in its answer):
   * final, nothing more is sent with these credentials.
   */
  constructor(code, { status, retryAfter } = {}) {
    super(code);
    this.name = 'HyponError';
    this.code = code;
    this.status = status;
    /** ms, from a Retry-After header (429, 503), when given. */
    this.retryAfter = retryAfter;
  }

  get final() {
    return this.code === 'refused';
  }
}

/** A network failure (while connecting or while reading the body), in our words. */
function networkError(err) {
  if (err instanceof HyponError) {
    return err;
  }
  const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return new HyponError(timeout ? 'timeout' : 'unreachable');
}

/**
 * The body, up to `limit` bytes, copied into a single buffer allocated once
 * (no list of chunks, no concatenation): a longer one is not an answer.
 */
export async function readBounded(response, limit) {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const buffer = new Uint8Array(limit);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (size + value.byteLength > limit) {
        throw new HyponError('too_large');
      }
      buffer.set(value, size);
      size += value.byteLength;
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  return new TextDecoder('utf-8').decode(buffer.subarray(0, size));
}

/** The body of an answer we do not read: let go. */
const drop = async (response) => {
  try {
    await response.body?.cancel?.();
  } catch {
    // Nothing to do: the answer is refused anyway.
  }
};

/** Retry-After in seconds (or an HTTP date) -> ms, undefined when absent or odd. */
function retryAfterOf(response, now) {
  const raw = response.headers?.get?.('retry-after');
  if (typeof raw !== 'string' || raw.length > 64) {
    return undefined;
  }
  if (/^\d{1,9}$/.test(raw.trim())) {
    return Number(raw.trim()) * 1000;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now()) : undefined;
}

/** JSON without the keys that could reach a prototype. */
export function parseJson(text) {
  try {
    return JSON.parse(text, (key, value) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value,
    );
  } catch {
    throw new HyponError('bad_answer');
  }
}

const TOKEN = /^[\x21-\x7e]{1,4096}$/;

export class HyponClient {
  constructor({
    username,
    password,
    oem = 0,
    fetchImpl = (...args) => globalThis.fetch(...args),
    timeout = HTTP_TIMEOUT,
    now = Date.now,
    onLogin = () => {},
  }) {
    this.username = username;
    // Not enumerable: never in a JSON nor in an inspection of the client.
    Object.defineProperty(this, 'password', { value: password, enumerable: false });
    this.oem = oem;
    this.fetch = fetchImpl;
    this.timeout = timeout;
    this.now = now;
    this.onLogin = onLogin;
    /** `{ value, expiresAt }`, in memory only. */
    Object.defineProperty(this, 'token', { value: undefined, enumerable: false, writable: true });
    this.loginsThisRead = 0;
    /** Requests one after the other, never two at once. */
    this.queue = Promise.resolve();
  }

  /** A new read: one login allowed again. */
  beginRead() {
    this.loginsThisRead = 0;
  }

  /** One HTTP exchange: `{ status, json }` for a 2xx answer, a HyponError otherwise. */
  exchange(path, init) {
    const run = async () => {
      try {
        const response = await this.fetch(`${API_BASE}${path}`, {
          ...init,
          // A redirect is never followed: the password and the token stay on this host.
          redirect: 'manual',
          // The whole answer, the body included, within the timeout.
          signal: AbortSignal.timeout(this.timeout),
        });
        const status = response.status;
        if (status === 429 || status >= 500) {
          await drop(response);
          throw new HyponError(status === 429 ? 'rate_limited' : 'server', {
            status,
            retryAfter: retryAfterOf(response, this.now),
          });
        }
        if (status >= 300 && status < 400) {
          await drop(response);
          throw new HyponError('redirect', { status });
        }
        if (status < 200 || status >= 300) {
          await drop(response);
          throw new HyponError('http', { status });
        }
        return parseJson(await readBounded(response, MAX_BODY_BYTES));
      } catch (err) {
        throw networkError(err);
      }
    };
    const job = this.queue.then(run, run);
    this.queue = job.catch(() => {});
    return job;
  }

  /** POST /login: a token, or `refused` (final) for refused credentials. */
  async login() {
    this.token = undefined;
    this.loginsThisRead += 1;
    let result;
    try {
      result = await this.exchange('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ username: this.username, password: this.password, oem: this.oem }),
      });
    } catch (err) {
      if (err.code === 'http' && (err.status === 401 || err.status === 403)) {
        throw new HyponError('refused', { status: err.status });
      }
      throw err;
    }
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new HyponError('bad_answer');
    }
    const data = Object.hasOwn(result, 'data') ? result.data : undefined;
    const token =
      data && typeof data === 'object' && Object.hasOwn(data, 'token') ? data.token : '';
    if (typeof token !== 'string' || !TOKEN.test(token)) {
      // A JSON answer without a token: the library's "Invalid credentials" case.
      throw new HyponError('refused');
    }
    this.token = { value: token, expiresAt: this.now() + TOKEN_VALIDITY };
    this.onLogin();
  }

  hasFreshToken() {
    return Boolean(this.token) && this.now() < this.token.expiresAt - TOKEN_MARGIN;
  }

  /** An authenticated GET: the JSON answer. */
  async get(path) {
    if (!this.hasFreshToken()) {
      if (this.loginsThisRead > 0) {
        // Never a second login in one read.
        throw new HyponError('unauthorized');
      }
      await this.login();
    }
    try {
      return await this.getWith(path, this.token.value);
    } catch (err) {
      if (err.code === 'http' && err.status === 401) {
        if (this.loginsThisRead > 0) {
          throw new HyponError('unauthorized', { status: 401 });
        }
        // The token ended early: one login, one new try, never more.
        await this.login();
        try {
          return await this.getWith(path, this.token.value);
        } catch (again) {
          if (again.code === 'http' && again.status === 401) {
            throw new HyponError('unauthorized', { status: 401 });
          }
          throw again;
        }
      }
      throw err;
    }
  }

  async getWith(path, token) {
    try {
      return await this.exchange(path, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
    } catch (err) {
      if (err.code === 'http' && err.status === 403) {
        throw new HyponError('forbidden', { status: 403 });
      }
      if (err.code === 'http' && err.status === 404) {
        throw new HyponError('not_found', { status: 404 });
      }
      throw err;
    }
  }

  /** Every page of a list (at most MAX_PAGES): `{ items, truncated }`. */
  async pages(pathOf) {
    const items = [];
    let total = 1;
    for (let page = 1; page <= total && page <= MAX_PAGES; page += 1) {
      const parsed = pageOf(await this.get(pathOf(page)));
      if (!parsed) {
        throw new HyponError('bad_answer');
      }
      items.push(...parsed.items.slice(0, 100));
      total = parsed.totalPages;
    }
    return { items, truncated: total > MAX_PAGES };
  }

  readPlants() {
    return this.pages((page) => `/plant/list2?page=${page}&page_size=10&refresh=true`);
  }

  readInverters(plantId) {
    return this.pages((page) => `/plant/${encodeURIComponent(plantId)}/inverter?page=${page}`);
  }

  readBatteries(plantId) {
    return this.pages(
      (page) => `/plant/${encodeURIComponent(plantId)}/battery?page=${page}&page_size=10`,
    );
  }

  async readMonitor(plantId) {
    const result = await this.get(`/plant/${encodeURIComponent(plantId)}/monitor?refresh=true`);
    const monitor = parseMonitor(
      result && typeof result === 'object' && Object.hasOwn(result, 'data')
        ? result.data
        : undefined,
    );
    if (!monitor) {
      throw new HyponError('bad_answer');
    }
    return monitor;
  }
}
