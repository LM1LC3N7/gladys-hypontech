// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container), so that
// a restart never reads the cloud before its time, never tries refused
// credentials again and never forgets an index held back:
// - `salt`: random, for the fingerprint below;
// - `lastAttemptAt`: the time of the last read (written before the read);
// - `pause`: the end of a pause asked by the cloud (429, 5xx);
// - `refused`: the fingerprint (HMAC with the salt) of the credentials the
//   cloud refused, erased at the first successful login. Never any
//   fingerprint of credentials that worked;
// - `indexes`: by index feature, the guard (reference and value held).
// Never a password, a token, a name or an address. A small JSON file written
// through a temporary file and a rename (0600), one save after the other.
// Read back bounded; failures are logged, never fatal. After gladys-zeversolar
// and gladys-webuntis (approved).
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';

export const DEFAULT_STATE_FILE = '/data/hypontech-state.json';
/** A larger file is not ours: ignored (read bounded). */
const MAX_STATE_BYTES = 256 * 1024;

export function createFileStore(file = DEFAULT_STATE_FILE) {
  /** The saves one after the other: two never share the temporary file. */
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
  };
  return {
    load() {
      try {
        if (statSync(file).size > MAX_STATE_BYTES) {
          return {};
        }
        const data = JSON.parse(readFileSync(file, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      } catch {
        return {};
      }
    },
    save(data) {
      const job = queue.then(
        () => write(data),
        () => write(data),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests). */
export function createMemoryStore(initial = {}) {
  let data = structuredClone(initial);
  const store = {
    saves: 0,
    load: () => structuredClone(data),
    async save(next) {
      data = structuredClone(next);
      store.saves += 1;
    },
    get data() {
      return data;
    },
  };
  return store;
}

/** The fingerprint of credentials, kept only once the cloud refused them. */
export const credentialsHash = (salt, config) =>
  createHmac('sha256', salt)
    .update(JSON.stringify(['credentials', config.oem, config.username, config.password]))
    .digest('hex');
