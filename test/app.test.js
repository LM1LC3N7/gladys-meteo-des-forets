// -----------------------------------------------------------------------------
// The app against the fake Gladys, the fake S3 (the real extract of 2026) and
// a virtual clock that moves at every read: when it reads (the times of the
// bulletin, never more often), what it publishes (the levels of the Paris
// days, never 0, never stale as new), the trigger, the off season, the
// pauses, /data, getConfig, the Test button.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import {
  DAY,
  DEVICE,
  F,
  HOUR,
  MINUTE,
  SECOND,
  createServer,
  created,
  csvUntil,
  setup,
} from './helpers/app.js';

const at = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString().slice(0, 16);
/** The wall times of the requests. */
const times = (t) => t.server.requests.map((r) => iso(r.at));

/** A setup whose server answers are dated. */
async function dated(options) {
  const server = options.server ?? (options.files ? createServer(options.files) : undefined);
  const t = await setup(server ? { ...options, server } : options);
  const srv = t.server;
  // The source keeps the fetch it was given: wrap that one.
  const inner = srv.fetch;
  t.app.source.fetchImpl = async (url, init) => {
    const answer = await inner(url, init);
    srv.requests.at(-1).at = t.app.now();
    return answer;
  };
  return t;
}

test('in season: read at once, levels of today and tomorrow, the bulletin, no event', async (t) => {
  const s = await dated({ files: { 2026: csvUntil('2026-08-11') } });
  t.after(() => s.stop());
  await s.start();
  assert.equal(s.server.count(), 1);
  assert.equal(
    s.server.requests[0].url,
    'https://meteofrance.s3.sbg.io.cloud.ovh.net/data/BULLETIN/MDF/mdf_2026.csv.gz',
  );
  assert.equal(s.server.requests[0].headers['If-None-Match'], undefined);
  // Bulletin of 11/08: J+1 (12/08) = 3, J+2 (13/08) = 3; it is 10:00 UTC on the 12th.
  assert.equal(s.last(F('13', 'today')), 3);
  assert.equal(s.last(F('13', 'tomorrow')), 3);
  assert.match(
    s.last(F('13', 'bulletin')),
    /^Bulletin du 11\/08\/2026 16:50 : 12\/08 élevé, 13\/08 élevé$/,
  );
  assert.deepEqual(s.gladys.fake.sceneEvents, []);
  const status = s.status();
  assert.equal(status.connected, true);
  assert.match(status.message.fr, /Dernier bulletin : 11\/08\/2026 16:50/);
  assert.match(status.message.fr, /Prochaine lecture : 12\/08\/2026 17:30/);
  assert.deepEqual(
    s.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [DEVICE('13')],
  );
});

test('in season: one read at 15:30 UTC once the bulletin is out, then nothing until the next day', async (t) => {
  const s = await dated({ files: { 2026: csvUntil('2026-08-11') } });
  t.after(() => s.stop());
  await s.start();
  s.server.files[2026] = csvUntil('2026-08-12');
  await s.wait(DAY + 5 * HOUR + 31 * MINUTE);
  // 12/08 15:30 finds the bulletin of the 12th; 13/08 15:30: 304 (the file did not change).
  assert.deepEqual(times(s), ['2026-08-12T10:00', '2026-08-12T15:30', '2026-08-13T15:30']);
  assert.ok(s.server.requests[1].headers['If-None-Match'], 'the ETag is sent');
  assert.ok(s.server.requests[2].headers['If-None-Match']);
});

test('the bulletin late: tried again at 16:30, 18:00, 20:30 UTC, never more than 4 times a day', async (t) => {
  const s = await dated({ files: { 2026: csvUntil('2026-08-11') } });
  t.after(() => s.stop());
  await s.start();
  await s.wait(DAY + 6 * HOUR);
  assert.deepEqual(times(s).slice(1), [
    '2026-08-12T15:30',
    '2026-08-12T16:30',
    '2026-08-12T18:00',
    '2026-08-12T20:30',
    '2026-08-13T15:30',
  ]);
});

test('Paris midnight: the levels move one day on without any request', async (t) => {
  const csv = [
    'date;num_dep;niveau_j1;niveau_j2',
    '2026-08-11T14:50:00Z;13;1;2',
    '2026-08-12T14:50:00Z;13;3;4',
    '',
  ].join('\n');
  const s = await dated({ files: { 2026: csv }, now: at('2026-08-12T16:00:00Z') });
  t.after(() => s.stop());
  await s.start();
  assert.equal(s.server.count(), 1);
  assert.deepEqual([s.last(F('13', 'today')), s.last(F('13', 'tomorrow'))], [1, 3]);
  // The 13th starts at 22:00 UTC (summer time).
  await s.wait(5 * HOUR + 59 * MINUTE);
  assert.deepEqual([s.last(F('13', 'today')), s.last(F('13', 'tomorrow'))], [1, 3]);
  await s.wait(2 * MINUTE);
  assert.equal(s.server.count(), 1, 'no request at midnight');
  assert.deepEqual([s.last(F('13', 'today')), s.last(F('13', 'tomorrow'))], [3, 4]);
  // The 14th: the bulletin of the 13th is missing; today is 4 (J+2 of the 12th),
  // tomorrow is unknown: nothing published, the old value is not replaced by 0.
  s.server.answer = () => new Response('', { status: 500 });
  await s.wait(DAY);
  assert.equal(s.last(F('13', 'today')), 4);
  assert.ok(!s.states(F('13', 'tomorrow')).includes(0));
});

test('a rise of the forecast fires the trigger once per level crossed; a restart never twice', async (t) => {
  const store = createMemoryStore();
  const base = csvUntil('2026-08-11');
  const s = await dated({ files: { 2026: base }, store });
  t.after(() => s.stop());
  await s.start();
  // Today (12/08) is 3 for the 13; the bulletin of the 12th says 4 for the 13th.
  s.server.files[2026] = `${base}2026-08-12T14:50:04Z;13;4;4;Bouches-du-Rhône\n`;
  await s.wait(6 * HOUR);
  const events = s.gladys.fake.sceneEvents;
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'fire_danger_forecast');
  assert.deepEqual(
    { ...events[0].data },
    {
      department: DEVICE('13'),
      level: '4',
      current_level: 4,
      level_name: 'Très élevé',
      previous_level: 3,
      day_after_level: 4,
      department_code: '13',
      forecast_date: '2026-08-13',
      bulletin_at: '2026-08-12T14:50:04.000Z',
    },
  );
  await s.stop();
  // A restart: the memory is in /data, the 304 changes nothing.
  const r = await dated({ server: s.server, store, now: s.app.now() });
  t.after(() => r.stop());
  await r.start();
  await r.wait(DAY);
  assert.deepEqual(r.gladys.fake.sceneEvents, []);
});

test('off season: one read a day at 17:30 UTC, "no bulletin" said, nothing published as a level', async (t) => {
  const s = await dated({ now: at('2026-11-11T08:00:00Z') });
  t.after(() => s.stop());
  await s.start();
  await s.wait(2 * DAY);
  assert.deepEqual(times(s), ['2026-11-11T08:00', '2026-11-11T17:30', '2026-11-12T17:30']);
  assert.equal(s.last(F('13', 'today')), undefined);
  assert.equal(s.last(F('13', 'bulletin')), 'Pas de bulletin (hors saison). Dernier : 05/10/2026.');
  const status = s.status();
  assert.equal(status.connected, true, 'off season is not an error');
  assert.match(status.message.fr, /Hors saison : pas de bulletin depuis le 05\/10\/2026/);
});

test('a new year without its file (404): off season, not an error, once a day', async (t) => {
  const store = createMemoryStore();
  const s = await dated({ now: at('2027-01-15T08:00:00Z'), store });
  t.after(() => s.stop());
  await s.start();
  await s.wait(DAY);
  assert.deepEqual(times(s), ['2027-01-15T08:00', '2027-01-15T17:30']);
  assert.match(s.server.requests[0].url, /mdf_2027\.csv\.gz$/);
  const status = s.status();
  assert.equal(status.connected, true);
  assert.match(status.message.fr, /Pas encore de bulletin en 2027/);
  assert.equal(s.last(F('13', 'bulletin')), 'Pas de bulletin (hors saison).');
});

test('the first bulletin of the season is seen the day it comes out', async (t) => {
  const s = await dated({ now: at('2027-05-30T08:00:00Z'), files: {} });
  t.after(() => s.stop());
  await s.start();
  s.server.files[2027] = 'date;num_dep;niveau_j1;niveau_j2\n2027-05-31T14:50:00Z;13;2;1\n';
  await s.wait(2 * DAY);
  assert.deepEqual(times(s), ['2027-05-30T08:00', '2027-05-30T17:30', '2027-05-31T17:30']);
  assert.equal(s.last(F('13', 'today')), 2);
  // A rise from "no bulletin" (low) to moderate: the event fires, not at the first read.
  assert.deepEqual(
    s.gladys.fake.sceneEvents.map((e) => e.data.level),
    ['2'],
  );
});

test('429: paused as asked (Retry-After), kept in /data across a restart; 5xx doubles the pause', async (t) => {
  const store = createMemoryStore();
  const server = createServer();
  server.answer = () => new Response('', { status: 429, headers: { 'retry-after': '7200' } });
  const s = await dated({ server, store });
  t.after(() => s.stop());
  await s.start();
  assert.equal(server.count(), 1);
  assert.equal(s.status().connected, false);
  assert.match(s.status().message.en, /asked to wait \(HTTP 429\)/);
  await s.wait(HOUR);
  await s.stop();
  // Restart within the pause: nothing before its end.
  const r = await dated({ server, store, now: s.app.now() });
  t.after(() => r.stop());
  server.answer = () => new Response('', { status: 503 });
  await r.start();
  await r.wait(59 * MINUTE);
  assert.equal(server.count(), 1, 'nothing during the pause');
  await r.wait(2 * MINUTE);
  assert.equal(server.count(), 2);
  // The second failure doubles: 40 min at least.
  await r.wait(38 * MINUTE);
  assert.equal(server.count(), 2);
});

test('a network failure: said in the status with the next try, the values kept', async (t) => {
  const server = createServer({ 2026: csvUntil('2026-08-11') });
  const s = await dated({ server });
  t.after(() => s.stop());
  await s.start();
  server.answer = () => 'hang';
  await s.wait(6 * HOUR);
  const status = s.status();
  assert.equal(status.connected, false);
  assert.match(status.message.en, /not read \(mdf_2026\.csv\.gz: timeout\): next try/);
  assert.equal(s.last(F('13', 'today')), 3);
  assert.ok(server.peak <= 1, 'one request at a time');
  assert.ok(server.count() <= 5);
});

test('a restart never reads sooner: the bulletin of the day held, nothing before tomorrow', async (t) => {
  const store = createMemoryStore();
  const server = createServer({ 2026: csvUntil('2026-08-12') });
  const s = await dated({ server, store, now: at('2026-08-12T15:40:00Z') });
  t.after(() => s.stop());
  await s.start();
  assert.equal(server.count(), 1);
  for (let i = 0; i < 5; i += 1) {
    await s.stop();
    const r = await dated({ server, store, now: s.app.now() + i * MINUTE });
    t.after(() => r.stop());
    await r.start();
    await r.wait(MINUTE);
    await r.stop();
  }
  assert.equal(server.count(), 1);
});

test('a restart within MIN_GAP of the last request waits; a missed slot is caught up', async (t) => {
  const store = createMemoryStore();
  const server = createServer({ 2026: csvUntil('2026-08-11') });
  const s = await dated({ server, store, now: at('2026-08-12T15:25:00Z') });
  t.after(() => s.stop());
  await s.start();
  await s.stop();
  // Restarted at 15:35: the slot of 15:30 is due, but 20 minutes after 15:25.
  const r = await dated({ server, store, now: at('2026-08-12T15:35:00Z') });
  t.after(() => r.stop());
  await r.start();
  assert.equal(server.count(), 1);
  await r.wait(10 * MINUTE + SECOND);
  assert.equal(server.count(), 2);
});

test('a wall clock set back or forward never makes a storm of requests', async (t) => {
  const wallOffset = { ms: 0 };
  const server = createServer({ 2026: csvUntil('2026-08-11') });
  const s = await dated({ server, wallOffset, now: at('2026-08-12T15:00:00Z') });
  t.after(() => s.stop());
  await s.start();
  for (const jump of [DAY, -2 * DAY, 3 * DAY, -HOUR, 5 * HOUR]) {
    wallOffset.ms += jump;
    await s.wait(10 * MINUTE);
  }
  await s.wait(2 * HOUR);
  // 2 h 50 of real time: 9 requests at most (MIN_GAP 20 min on the monotonic clock).
  assert.ok(server.count() <= 9, `${server.count()} requests`);
  assert.ok(server.peak <= 1);
});

test('getConfig failing in connected: retried, status said, then the start', async (t) => {
  const s = await dated({});
  t.after(() => s.stop());
  let calls = 0;
  const run = s.app.connected(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('down'), { status: 503 });
    return { departments: '13' };
  });
  await run;
  assert.equal(s.status().connected, false);
  assert.match(s.status().message.en, /Waiting for the configuration from Gladys \(attempt 1\)/);
  assert.equal(s.server.count(), 0);
  await s.wait(6 * SECOND);
  assert.equal(calls, 2);
  assert.equal(s.server.count(), 1);
  assert.equal(s.status().connected, true);
});

test('/data unreadable: read again every 10 s, never written over meanwhile, given up after a minute', async (t) => {
  const store = createMemoryStore({ lastAttemptAt: 1 });
  store.loadState = 'unreadable';
  const s = await dated({ store });
  t.after(() => s.stop());
  await s.start();
  assert.equal(s.server.count(), 0, 'no read before /data is known');
  // A restart (configuration saved) and a stop meanwhile: never written over.
  await s.app.start({ departments: '13' });
  await s.app.stop();
  await s.start();
  assert.equal(store.saves, 0);
  assert.match(s.status().message.en, /\/data was unreadable/);
  await s.wait(25 * SECOND);
  assert.ok(store.loads >= 3);
  store.loadState = 'ok';
  await s.wait(10 * SECOND);
  assert.equal(s.server.count(), 1);
  assert.doesNotMatch(s.status().message.en, /\/data/);
  // Never readable: the session goes on after DATA_TRIES.
  const never = createMemoryStore();
  never.loadHang = true;
  const n = await dated({ store: never });
  t.after(() => n.stop());
  await n.start();
  await n.wait(120 * SECOND);
  assert.equal(n.server.count(), 1);
  assert.match(n.status().message.en, /\/data was unreadable/);
});

test('/data that cannot be written never stops a read nor a publication', async (t) => {
  const store = createMemoryStore();
  store.saveHang = true;
  const s = await dated({ store });
  t.after(() => s.stop());
  await s.start();
  // One wait of 5 s for the first write; the next ones never wait on it.
  await s.wait(6 * SECOND);
  assert.equal(s.server.count(), 1);
  assert.equal(s.last(F('13', 'today')), 3);
  assert.match(s.status().message.en, /\/data does not answer in time/);
});

test('the Test button never reads sooner; it says the bulletin and the next read', async (t) => {
  const s = await dated({});
  t.after(() => s.stop());
  await s.start();
  const answer = await s.app.testConnection();
  assert.equal(s.server.count(), 1);
  assert.match(answer.fr, /Prochaine lecture/);
  for (let i = 0; i < 5; i += 1) await s.app.testConnection();
  assert.equal(s.server.count(), 1);
});

test('the configuration: no department said, nothing read; unknown codes said; a new one read at once', async (t) => {
  const s = await dated({ config: { departments: '' } });
  t.after(() => s.stop());
  await s.start({ departments: '' });
  await s.wait(DAY);
  assert.equal(s.server.count(), 0);
  assert.equal(s.status().connected, false);
  assert.match(s.status().message.fr, /Aucun département/);
  await s.app.start({ departments: '13, 971, 2a' });
  await s.wait(SECOND);
  assert.equal(s.server.count(), 1);
  assert.match(s.status().message.fr, /inconnu\(s\) ignoré\(s\) : 971/);
  assert.match(s.status().message.fr, /À créer dans la Découverte : Corse-du-Sud \(2A\)/);
  assert.deepEqual(
    s.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [DEVICE('13'), DEVICE('2A')],
  );
  // 83 added 30 minutes later: not in the cache, read without the ETag.
  await s.wait(30 * MINUTE);
  await s.app.start({ departments: '13, 2A, 83' });
  await s.wait(SECOND);
  assert.equal(s.server.count(), 2);
  assert.equal(s.server.requests[1].headers['If-None-Match'], undefined);
});

test('a device created: its levels at once from the bulletins kept, no request', async (t) => {
  const s = await dated({ config: { departments: '13, 83' } });
  t.after(() => s.stop());
  await s.start({ departments: '13, 83' });
  assert.equal(s.server.count(), 1);
  assert.equal(s.last(F('83', 'today')), undefined);
  const device = created('83');
  s.gladys.devices.push(device);
  await s.app.deviceChanged(device);
  assert.equal(s.server.count(), 1);
  assert.equal(typeof s.last(F('83', 'today')), 'number');
  assert.equal(typeof s.last(F('83', 'bulletin')), 'string');
});

test('a value is published only when it changed: a restart republishes nothing', async (t) => {
  const store = createMemoryStore();
  const s = await dated({ store });
  t.after(() => s.stop());
  await s.start();
  const count = s.gladys.fake.states.length;
  assert.ok(count >= 3);
  await s.stop();
  const r = await dated({ store, server: s.server, now: s.app.now() + MINUTE });
  t.after(() => r.stop());
  await r.start();
  assert.equal(r.gladys.fake.states.length, 0);
});

test('a file cut or damaged: refused, the values kept, said', async (t) => {
  const server = createServer({ 2026: csvUntil('2026-08-11') });
  const s = await dated({ server });
  t.after(() => s.stop());
  await s.start();
  server.files[2026] = '<html>maintenance</html>';
  await s.wait(6 * HOUR);
  assert.equal(s.last(F('13', 'today')), 3);
  assert.equal(s.status().connected, false);
  assert.match(s.status().message.en, /not a Météo des forêts file/);
});

test('a crash during a request: the next start never reads sooner (the attempt was in /data first)', async (t) => {
  const store = createMemoryStore();
  const server = createServer({ 2026: csvUntil('2026-08-11') });
  server.answer = () => 'hang';
  const s = await dated({ server, store });
  await s.start();
  assert.equal(server.count(), 1);
  // No stop: the process died. A new one on the same /data, a minute later.
  server.answer = () => undefined;
  const r = await dated({ server, store, now: s.app.now() + MINUTE });
  t.after(() => r.stop());
  t.after(() => s.stop());
  await r.start();
  await r.wait(18 * MINUTE);
  assert.equal(server.count(), 1);
  await r.wait(2 * MINUTE);
  assert.equal(server.count(), 2);
});

test('states refused by Gladys: sent again at the next wake-up, never lost', async (t) => {
  const s = await dated({});
  t.after(() => s.stop());
  const publish = s.gladys.publishStates.bind(s.gladys);
  let refuse = true;
  s.gladys.publishStates = async (states) => {
    if (refuse) throw new Error('503');
    return publish(states);
  };
  await s.start();
  assert.equal(s.last(F('13', 'today')), undefined);
  refuse = false;
  await s.wait(16 * MINUTE);
  assert.equal(s.last(F('13', 'today')), 3);
  assert.equal(s.server.count(), 1);
});
