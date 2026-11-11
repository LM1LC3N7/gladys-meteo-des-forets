// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake file server (the real extract
// of test/fixtures, gzipped, with an ETag and the 304 of S3) and a virtual
// clock that moves at every read.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ForestApp } from '../../src/app.js';
import { ForestSource } from '../../src/source.js';
import { buildDepartmentDevice } from '../../src/devices.js';
import { createMemoryStore } from '../../src/store.js';
import { settle, testClock } from '../kit/clock.mjs';

export const SELECTOR = 'meteo-des-forets';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const fixture = (name) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
/** The real lines of 2026 for 13, 83, 2A and 75 (bulletins from 2026-05-28 to 2026-10-05). */
export const CSV_2026 = fixture('mdf_2026-extract.csv');

/** The extract cut after the bulletin of `day` (YYYY-MM-DD, included). */
export const csvUntil = (day) =>
  CSV_2026.split('\n')
    .filter((line, i) => i === 0 || (line !== '' && line.slice(0, 10) <= day))
    .join('\n') + '\n';

export const F = (code, key) => `ext:${SELECTOR}:dep:${code}:${key}`;
export const DEVICE = (code) => `ext:${SELECTOR}:dep:${code}`;

/** The device of a department as the user created it. */
export function created(code = '13') {
  return buildDepartmentDevice(createFakeGladys({ selector: SELECTOR }), code, 'fr');
}

/**
 * A fake S3: `server.files[year]` is the CSV of the year (absent: 404),
 * served gzipped with a strong ETag of its content; If-None-Match equal: 304.
 * `server.answer(url, init)` may return a Response, 'hang' (aborted by the
 * signal), or undefined (the default). Records every request.
 */
export function createServer(files = { 2026: CSV_2026 }) {
  const server = {
    files: { ...files },
    requests: [],
    inFlight: 0,
    peak: 0,
    answer: () => undefined,
  };
  server.fetch = async (url, init = {}) => {
    server.requests.push({ url, headers: { ...init.headers }, redirect: init.redirect });
    server.inFlight += 1;
    server.peak = Math.max(server.peak, server.inFlight);
    try {
      const answer = await server.answer(url, init);
      if (answer === 'hang') {
        await new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      if (answer instanceof Response) return answer;
      const year = /mdf_(\d{4})\.csv\.gz$/.exec(url)?.[1];
      const csv = server.files[year];
      if (csv === undefined) return new Response('<Error>NoSuchKey</Error>', { status: 404 });
      const etag = `"${Buffer.from(String(csv.length)).toString('hex')}-${year}"`;
      if (init.headers?.['If-None-Match'] === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      return new Response(gzipSync(Buffer.from(csv)), {
        status: 200,
        headers: { 'content-type': 'binary/octet-stream', etag },
      });
    } finally {
      server.inFlight -= 1;
    }
  };
  server.count = () => server.requests.length;
  return server;
}

export async function setup({
  devices = [created('13')],
  store = createMemoryStore(),
  config = { departments: '13', language: 'fr' },
  now = Date.parse('2026-08-12T10:00:00Z'),
  // The extract as it was at `now` (the bulletin of a day is out at 14:50 UTC).
  server = createServer({ 2026: csvUntil(new Date(now - 15 * HOUR).toISOString().slice(0, 10)) }),
  wallOffset = { ms: 0 },
  clockStep,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const clock = testClock({ start: now, ...(clockStep ? { step: clockStep } : {}) });
  // The timers of the app, with their due time: `wait` jumps from one to the next.
  const live = new Map();
  const timers = {
    setTimeout(fn, ms, ...args) {
      const delay = Math.max(0, Number(ms) || 0);
      const h = clock.timers.setTimeout(() => {
        live.delete(h);
        fn(...args);
      }, delay);
      live.set(h, clock.elapsed + delay);
      return h;
    },
    clearTimeout(h) {
      live.delete(h);
      clock.timers.clearTimeout(h);
    },
  };
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const source = new ForestSource({ fetchImpl: server.fetch, timers });
  const app = new ForestApp({
    gladys,
    logger: { info: log, warn: log, error: log, debug: log },
    now: () => clock.now() + wallOffset.ms,
    monotonic: clock.monotonic,
    timers,
    store,
    source,
  });
  /** Moves the clock on by `ms`, timer after timer, letting every promise of the way run. */
  const wait = async (ms) => {
    const end = clock.elapsed + ms;
    for (let guard = 0; guard < 20_000; guard += 1) {
      await settle(20);
      // A read running on real work (the gunzip runs in the thread pool): let
      // it end before the clock moves, never longer than 200 real ms (a read
      // waiting on a virtual timer needs the clock to move).
      if (app.busy) {
        await Promise.race([
          app.busy.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 200)),
        ]);
        await settle(5);
      }
      const next = Math.min(...live.values());
      if (!(next <= end)) break;
      await clock.advance(Math.max(0, next - clock.elapsed));
    }
    await clock.advance(Math.max(0, end - clock.elapsed));
    await settle(20);
  };
  /** Starts the app; the virtual clock moves on while the start waits on it (a slow /data). */
  const start = async (cfg = config) => {
    let done = false;
    const run = app.start(cfg).finally(() => {
      done = true;
    });
    for (let i = 0; i < 120 && !done; i += 1) await wait(i === 0 ? 0 : SECOND);
    await run;
    await wait(SECOND);
  };
  /** Stops the app; the virtual clock moves on while the stop waits on it (a frozen /data). */
  const stop = async () => {
    let done = false;
    const run = app.stop().finally(() => {
      done = true;
    });
    for (let i = 0; i < 120 && !done; i += 1) await wait(i === 0 ? 0 : SECOND);
    await run;
  };
  const states = (featureId) =>
    gladys.fake.states
      .filter((s) => s.device_feature_external_id === featureId)
      .map((s) => s.state ?? s.text);
  const last = (featureId) => states(featureId).at(-1);
  const status = () => gladys.fake.connectionStatus;
  return {
    app,
    gladys,
    clock,
    timers,
    live,
    store,
    server,
    start,
    stop,
    wait,
    lines,
    last,
    states,
    status,
  };
}
