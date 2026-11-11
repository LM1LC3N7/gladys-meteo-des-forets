// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): the
// time of the last read (a restart never reads sooner), the pause asked by the
// server (429/5xx), the cache of the bulletins of the followed departments
// with the ETag of the file, the values last published and the memory of the
// trigger. A small JSON file, written through a temporary file and a rename,
// one save after the other. An unreadable file is kept aside once
// (`.unreadable`) before the first save replaces it. Taken from
// gladys-feux-canada (from gladys-iskra, approved).
// -----------------------------------------------------------------------------

import { copyFileSync } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';

export const DEFAULT_STATE_FILE = '/data/meteo-des-forets-state.json';
/** A larger file is not ours: ignored (read bounded). */
const MAX_STATE_BYTES = 256 * 1024;

export function createFileStore(file = DEFAULT_STATE_FILE) {
  /** The saves one after the other: two never share the temporary file. */
  let queue = Promise.resolve();
  let unreadable = false;
  const write = async (data) => {
    if (unreadable) {
      try {
        copyFileSync(file, `${file}.unreadable`);
      } catch {
        // Nothing to keep aside (gone meanwhile): the save goes on.
      }
      unreadable = false;
    }
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  };
  return {
    /** Resolves `{ data, state: 'ok' | 'missing' | 'unreadable' }` (the app bounds the wait). */
    async load() {
      try {
        if ((await stat(file)).size > MAX_STATE_BYTES) {
          unreadable = true;
          return { data: {}, state: 'unreadable' };
        }
        const data = JSON.parse(await readFile(file, 'utf8'));
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          unreadable = false;
          return { data, state: 'ok' };
        }
        unreadable = true;
        return { data: {}, state: 'unreadable' };
      } catch (err) {
        if (err?.code === 'ENOENT') {
          return { data: {}, state: 'missing' };
        }
        unreadable = true;
        return { data: {}, state: 'unreadable' };
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

/**
 * The same in memory (tests): `failSave` makes the next saves fail, `loadState`
 * ('unreadable') or `loadHang` (never answers) the next loads.
 */
export function createMemoryStore(initial = {}) {
  let data = structuredClone(initial);
  const store = {
    failSave: false,
    saveHang: false,
    loadState: 'ok',
    loadHang: false,
    saves: 0,
    loads: 0,
    async load() {
      store.loads += 1;
      if (store.loadHang) return new Promise(() => {});
      if (store.loadState !== 'ok') return { data: {}, state: store.loadState };
      return { data: structuredClone(data), state: 'ok' };
    },
    async save(next) {
      store.saves += 1;
      if (store.saveHang) return new Promise(() => {});
      if (store.failSave) {
        throw new Error('EROFS');
      }
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
  };
  return store;
}
