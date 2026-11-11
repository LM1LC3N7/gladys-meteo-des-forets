// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) sped
// up 3,600 times (one hour a second), against a real local HTTP server serving
// the extract gzipped: the reads start at once, then at the slots of 15:30,
// 16:30 and 18:00 UTC while the bulletin of the day is missing, never sooner
// (late only by the load), one request at a time, with a bounded number of
// timers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ForestApp } from '../src/app.js';
import { ForestSource } from '../src/source.js';
import { createMemoryStore } from '../src/store.js';
import { realClock } from './kit/clock.mjs';
import { SELECTOR, created, csvUntil } from './helpers/app.js';

const SPEED = 3600;
const START = Date.parse('2026-08-12T15:00:00Z');
const MINUTE = 60_000;

test('real clock x3600: a read at once, then at the slots, never sooner; one at a time', async (t) => {
  let inFlight = 0;
  let peak = 0;
  const body = gzipSync(Buffer.from(csvUntil('2026-08-11')));
  const server = createServer((req, res) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'binary/octet-stream', etag: '"v1"' });
      res.end(body);
      inFlight -= 1;
    }, 2);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const clock = realClock({ speed: SPEED });
  t.after(() => clock.close());
  const w0 = clock.now();
  const now = () => START + (clock.now() - w0);
  const gladys = createFakeGladys({ selector: SELECTOR, devices: [created('13')] });
  await gladys.connect();
  const reads = [];
  const base = `http://127.0.0.1:${server.address().port}`;
  const quiet = () => {};
  const app = new ForestApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    source: new ForestSource({
      timers: clock.timers,
      fetchImpl: (url, init) => {
        reads.push(now());
        return fetch(`${base}/${url.split('/').pop()}`, {
          ...init,
          signal: AbortSignal.timeout(5000),
        });
      },
    }),
  });
  t.after(() => app.stop());
  await app.start({ departments: '13' });
  // 3 h 15 of simulated time.
  await clock.sleep(195 * MINUTE);
  await app.stop();
  const expected = ['15:00', '15:30', '16:30', '18:00'].map((hm) =>
    Date.parse(`2026-08-12T${hm}:00Z`),
  );
  assert.equal(reads.length, expected.length, reads.map((r) => new Date(r).toISOString()).join());
  for (const [i, at] of reads.entries()) {
    assert.ok(at >= expected[i], `read ${i} early: ${new Date(at).toISOString()}`);
    assert.ok(at - expected[i] < 5 * MINUTE, `read ${i} late: ${new Date(at).toISOString()}`);
  }
  assert.equal(peak, 1, 'never two requests at once');
  assert.ok(clock.timersSet < 200, `${clock.timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(
    gladys.fake.states.find((s) => s.device_feature_external_id.endsWith(':today'))?.state,
    3,
  );
});
