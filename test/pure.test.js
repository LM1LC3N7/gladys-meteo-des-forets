// -----------------------------------------------------------------------------
// The pure parts: the CSV of every year seen (2024, 2025, 2026), the days of
// Paris (both changes of time, midnight east and west of UTC), the level of a
// day, the configuration, the ids, the trigger, the bounded HTTP read and the
// bounded gunzip, the /data file.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  addDays,
  inSeason,
  levelOn,
  levelsAt,
  nextParisMidnight,
  parisDate,
  parisYear,
  parseBulletins,
  parseIssueTime,
  parseLevel,
  utcSlot,
  validBulletin,
} from '../src/bulletin.js';
import { normalizeConfig } from '../src/config.js';
import { DEPARTMENTS, normalizeDepartment } from '../src/departments.js';
import { buildDepartmentDevice, parseExternalId } from '../src/devices.js';
import { getFile, retryAfterMs } from '../src/http.js';
import { bulletinText, levelName } from '../src/i18n.js';
import { decompress } from '../src/source.js';
import { createFileStore } from '../src/store.js';
import { departmentEvents, validMemory } from '../src/triggers.js';
import { CSV_2026, fixture, created } from './helpers/app.js';

const H = 3_600_000;
const at = (iso) => Date.parse(iso);

test('the 2026 file: separator ;, codes 01 and 2A, the latest bulletin per day, newest first', () => {
  const r = parseBulletins(CSV_2026, { wanted: ['13', '2A', '83'] });
  assert.equal(r.lines, 524);
  assert.equal(r.unreadable, 0);
  assert.equal(new Date(r.newestAt).toISOString(), '2026-10-05T14:50:04.000Z');
  const b13 = r.byDepartment.get('13');
  assert.equal(b13.length, 4);
  assert.deepEqual(
    b13.map((b) => b.issued),
    ['2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02'],
  );
  assert.ok(r.byDepartment.has('2A'));
  assert.equal(r.byDepartment.has('75'), false, 'only the wanted departments are kept');
});

test('the 2025 and 2024 files: separator, codes without zero, other column names', () => {
  for (const [file, first] of [
    ['mdf_2025-head.csv', '2025-06-15'],
    ['mdf_2024-head.csv', '2024-06-14'],
  ]) {
    const r = parseBulletins(fixture(file), { wanted: ['13'] });
    assert.equal(r.unreadable, 0, file);
    assert.ok(r.byDepartment.get('13').length > 0, file);
    assert.equal(r.byDepartment.get('13')[0].issued, first, file);
  }
});

test('a file that is not the one expected is refused; a broken line is counted, never read', () => {
  assert.throws(() => parseBulletins('a;b;c\n1;2;3\n'), { code: 'bad_answer' });
  assert.throws(() => parseBulletins('<html>Error</html>'), { code: 'bad_answer' });
  assert.throws(
    () => parseBulletins('date;num_dep;niveau_j1;niveau_j2\nx;13;1;1\n', { wanted: ['13'] }),
    { code: 'bad_answer' },
  );
  const csv = [
    'date;num_dep;niveau_j1;niveau_j2;nom_dep',
    '2026-08-10T14:50:00Z;13;3;2;Bouches-du-Rhône',
    '2026-08-11T14:50:00Z;13;;5;Bouches-du-Rhône',
    '2026-08-11T14:50:00Z;971;2;2;Guadeloupe',
    '2026-02-30T14:50:00Z;13;2;2;x',
    '2026-08-12T14:50:00Z;83;0;4;Var',
    '',
  ].join('\r\n');
  const r = parseBulletins(csv, { wanted: ['13', '83'] });
  assert.equal(r.unreadable, 2);
  const [b11] = r.byDepartment.get('13');
  assert.deepEqual([b11.j1, b11.j2], [null, null], 'empty and 5 are unknown, never 0');
  assert.deepEqual(
    [r.byDepartment.get('83')[0].j1, r.byDepartment.get('83')[0].j2],
    [null, 4],
    '0 is not a level',
  );
  // A line dated after `notAfter` (the future) is unreadable.
  const future = parseBulletins(csv, { wanted: ['13'], notAfter: at('2026-08-11T00:00:00Z') });
  assert.equal(future.byDepartment.get('13').length, 1);
  // Too many lines.
  const big = `date;num_dep;niveau_j1;niveau_j2\n${'2026-08-10T14:50:00Z;13;1;1\n'.repeat(100_001)}`;
  assert.throws(() => parseBulletins(big), { code: 'too_large' });
});

test('r1 M5/M6: same second, the later line wins; a giant line is unreadable, never split', () => {
  const same =
    'date;num_dep;niveau_j1;niveau_j2\n2026-08-10T14:50:04Z;13;3;3\n2026-08-10T14:50:04Z;13;4;4\n';
  assert.equal(parseBulletins(same, { wanted: ['13'] }).byDepartment.get('13')[0].j1, 4);
  const giant = `date;num_dep;niveau_j1;niveau_j2\n${';'.repeat(5000)}\n2026-08-10T14:50:04Z;13;2;2\n`;
  const r = parseBulletins(giant, { wanted: ['13'] });
  assert.equal(r.unreadable, 1);
  assert.equal(r.byDepartment.get('13')[0].j1, 2);
  assert.throws(() => parseBulletins(`${'x;'.repeat(3000)}\n`), { code: 'bad_answer' });
});

test('a bulletin issued twice the same day: the latest wins', () => {
  const csv = [
    'date;num_dep;niveau_j1;niveau_j2',
    '2026-08-10T14:50:00Z;13;2;2',
    '2026-08-10T17:10:00Z;13;3;2',
    '2026-08-10T15:00:00Z;13;1;1',
  ].join('\n');
  const [b] = parseBulletins(csv, { wanted: ['13'] }).byDepartment.get('13');
  assert.equal(b.j1, 3);
});

test('strict values: time of issue, level, department code', () => {
  assert.equal(parseIssueTime('2026-08-10T14:50:07Z'), at('2026-08-10T14:50:07Z'));
  assert.equal(parseIssueTime('2026-08-10T14:50Z'), at('2026-08-10T14:50:00Z'));
  for (const bad of [
    '2026-08-10 14:50:07',
    '2026-08-10T25:00:00Z',
    '2026-13-01T00:00:00Z',
    '',
    null,
  ]) {
    assert.equal(parseIssueTime(bad), undefined, String(bad));
  }
  assert.deepEqual(['1', ' 4 ', '0', '5', '', '2.0', 'x', null].map(parseLevel), [
    1,
    4,
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  assert.equal(normalizeDepartment('1'), '01');
  assert.equal(normalizeDepartment(' 2a '), '2A');
  assert.equal(normalizeDepartment('75'), '75');
  for (const bad of ['20', '971', '00', '96', '2C', '', '1.0', '013']) {
    assert.equal(normalizeDepartment(bad), undefined, bad);
  }
  assert.equal(DEPARTMENTS.size, 96);
});

test('the days of Paris: midnight in summer and winter, both changes of time', () => {
  assert.equal(parisDate(at('2026-08-11T21:59:59Z')), '2026-08-11');
  assert.equal(parisDate(at('2026-08-11T22:00:00Z')), '2026-08-12');
  assert.equal(parisDate(at('2026-12-31T22:59:59Z')), '2026-12-31');
  assert.equal(parisDate(at('2026-12-31T23:00:00Z')), '2027-01-01');
  assert.equal(parisYear(at('2026-12-31T23:00:00Z')), 2027);
  assert.equal(nextParisMidnight(at('2026-08-11T10:00:00Z')), at('2026-08-11T22:00:00Z'));
  assert.equal(nextParisMidnight(at('2026-08-11T22:00:00Z')), at('2026-08-12T22:00:00Z'));
  // 29 March 2026: 02:00 -> 03:00 (the day is 23 hours long).
  assert.equal(nextParisMidnight(at('2026-03-29T00:30:00Z')), at('2026-03-29T22:00:00Z'));
  assert.equal(nextParisMidnight(at('2026-03-28T12:00:00Z')), at('2026-03-28T23:00:00Z'));
  // 25 October 2026: 03:00 -> 02:00 (25 hours).
  assert.equal(nextParisMidnight(at('2026-10-24T23:00:00Z')), at('2026-10-25T23:00:00Z'));
  assert.equal(nextParisMidnight(at('2026-10-24T21:00:00Z')), at('2026-10-24T22:00:00Z'));
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(utcSlot(at('2026-08-11T23:30:00Z'), 930), at('2026-08-11T15:30:00Z'));
  assert.equal(utcSlot(at('2026-08-11T23:30:00Z'), 930, 1), at('2026-08-12T15:30:00Z'));
});

const bulletin = (iso, j1, j2) => ({ at: at(iso), issued: parisDate(at(iso)), j1, j2 });

test('the level of a day: J+1 of the day before, else J+2 of two days before; unknown stays unknown', () => {
  const list = [bulletin('2026-08-11T14:50:00Z', 3, 4), bulletin('2026-08-10T14:50:00Z', 2, 2)];
  assert.equal(levelOn(list, '2026-08-12').level, 3);
  assert.equal(levelOn(list, '2026-08-13').level, 4);
  assert.equal(levelOn(list, '2026-08-11').level, 2);
  assert.equal(levelOn(list, '2026-08-14'), undefined);
  assert.equal(levelOn(list, '2026-08-10'), undefined, 'never from a bulletin of the day itself');
  // A J+1 unknown is never replaced by the older J+2.
  const broken = [
    bulletin('2026-08-11T14:50:00Z', null, 4),
    bulletin('2026-08-10T14:50:00Z', 2, 1),
  ];
  assert.equal(levelOn(broken, '2026-08-12'), undefined);
  // In Paris time: the evening of the 11th (after 22:00 UTC) is already the 12th.
  assert.deepEqual(levelsAt(list, at('2026-08-11T21:00:00Z')), {
    today: 2,
    tomorrow: 3,
    dayAfter: 4,
  });
  assert.deepEqual(levelsAt(list, at('2026-08-11T22:30:00Z')), {
    today: 3,
    tomorrow: 4,
    dayAfter: undefined,
  });
  // Winter: midnight is 23:00 UTC.
  const winter = [bulletin('2026-12-01T14:50:00Z', 2, 3)];
  assert.equal(levelsAt(winter, at('2026-12-01T22:30:00Z')).today, undefined);
  assert.equal(levelsAt(winter, at('2026-12-01T23:30:00Z')).today, 2);
  assert.equal(inSeason(at('2026-10-05T14:50:00Z'), at('2026-10-08T10:00:00Z'), 3), true);
  assert.equal(inSeason(at('2026-10-05T14:50:00Z'), at('2026-10-09T10:00:00Z'), 3), false);
  assert.equal(inSeason(undefined, at('2026-10-09T10:00:00Z'), 3), false);
});

test('a bulletin of /data is checked: levels 1-4 or null, never in the future', () => {
  const now = at('2026-08-12T10:00:00Z');
  assert.ok(validBulletin({ at: at('2026-08-11T14:50:00Z'), j1: 3, j2: null }, now));
  for (const bad of [
    { at: at('2026-08-13T14:50:00Z'), j1: 3, j2: 3 },
    { at: at('2026-08-11T14:50:00Z'), j1: 0, j2: 3 },
    { at: at('2026-08-11T14:50:00Z'), j1: '3', j2: 3 },
    { at: 'x', j1: 3, j2: 3 },
    null,
  ]) {
    assert.equal(validBulletin(bad, now), undefined, JSON.stringify(bad));
  }
});

test('the configuration: codes in order, no duplicate, 10 at most, invalid ones said', () => {
  const c = normalizeConfig({ departments: '13, 83;2a 13\n971, x\u0007y', language: 'EN' });
  assert.deepEqual(c.departments, ['13', '83', '2A']);
  assert.deepEqual(c.invalid, ['971', 'x?y']);
  assert.equal(c.language, 'en');
  const many = normalizeConfig({ departments: '01 02 03 04 05 06 07 08 09 10 11 12' });
  assert.equal(many.departments.length, 10);
  assert.equal(many.tooMany, true);
  assert.deepEqual(normalizeConfig({ departments: ['13', '2A'] }).departments, ['13', '2A']);
  assert.deepEqual(normalizeConfig().departments, []);
  assert.deepEqual(normalizeConfig({ departments: 42 }).departments, []);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});

test('the ids of the devices are fixed: dep:<code>', () => {
  const device = created('2A');
  assert.equal(device.external_id, 'ext:meteo-des-forets:dep:2A');
  assert.deepEqual(parseExternalId(device.external_id), { code: '2A' });
  assert.equal(parseExternalId('ext:meteo-des-forets:dep:20'), undefined);
  assert.equal(parseExternalId('ext:meteo-des-forets:dep:13:today'), undefined);
  assert.equal(parseExternalId('ext:other'), undefined);
  for (const f of device.features) assert.equal(f.read_only, true);
  const en = buildDepartmentDevice({ externalId: (s) => `ext:x:${s}` }, '13', 'en');
  assert.match(en.name, /Bouches-du-Rhône \(13\)/);
});

test('the texts: level names, the bulletin, bounded', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((l) => levelName(l, 'fr')),
    ['Faible', 'Modéré', 'Élevé', 'Très élevé', '?'],
  );
  const b = bulletin('2026-08-11T14:50:00Z', 3, 4);
  assert.equal(
    bulletinText({ kind: 'recent', bulletin: b, j1Date: '2026-08-12', j2Date: '2026-08-13' }, 'fr'),
    'Bulletin du 11/08/2026 16:50 : 12/08 élevé, 13/08 très élevé',
  );
  assert.equal(
    bulletinText({ kind: 'offSeason', bulletin: b }, 'en'),
    'No bulletin (off season). Last one: 11/08/2026.',
  );
  assert.equal(bulletinText({ kind: 'offSeason' }, 'fr'), 'Pas de bulletin (hors saison).');
});

test('the trigger: one event per level crossed, never at the first read, never twice, never late', () => {
  const now = at('2026-08-11T15:30:00Z');
  const old = [bulletin('2026-08-10T14:50:00Z', 2, 2)];
  const first = departmentEvents(undefined, old, { deviceId: 'd', code: '13', now });
  assert.deepEqual(first.events, []);
  const rise = [bulletin('2026-08-11T14:50:00Z', 4, 3), ...old];
  assert.deepEqual(
    departmentEvents(undefined, rise, { deviceId: 'd', code: '13', now }).events,
    [],
    'a fresh rise at the first read fires nothing',
  );
  const r = departmentEvents(first.memory, rise, { deviceId: 'd', code: '13', now });
  assert.deepEqual(
    r.events.map((e) => e.data.level),
    ['3', '4'],
  );
  assert.deepEqual(
    {
      ...r.events[0].data,
    },
    {
      department: 'd',
      level: '3',
      current_level: 4,
      level_name: 'Très élevé',
      previous_level: 2,
      day_after_level: 3,
      department_code: '13',
      forecast_date: '2026-08-12',
      bulletin_at: '2026-08-11T14:50:00.000Z',
    },
  );
  // Seen: nothing again.
  assert.deepEqual(departmentEvents(r.memory, rise, { deviceId: 'd', code: '13', now }).events, []);
  // A correction the same day: compared with the bulletin already seen that day.
  const corrected = [bulletin('2026-08-11T17:10:00Z', 4, 4), ...old];
  assert.deepEqual(
    departmentEvents(r.memory, corrected, { deviceId: 'd', code: '13', now: now + 2 * H }).events,
    [],
  );
  // Found more than 24 h late: remembered, never fired.
  const late = departmentEvents(first.memory, rise, {
    deviceId: 'd',
    code: '13',
    now: at('2026-08-12T15:00:00Z'),
  });
  assert.deepEqual(late.events, []);
  assert.equal(late.memory.seenAt, rise[0].at);
  // First bulletin of the season: no level that day, counts as low.
  const season = departmentEvents(
    { seenAt: at('2025-09-30T14:50:00Z'), issued: '2025-09-30', j1: 1 },
    [bulletin('2026-06-01T14:50:00Z', 2, 2)],
    { deviceId: 'd', code: '13', now: at('2026-06-01T15:30:00Z') },
  );
  assert.deepEqual(
    season.events.map((e) => e.data.level),
    ['2'],
  );
  // Unknown level of tomorrow: nothing.
  assert.deepEqual(
    departmentEvents(first.memory, [bulletin('2026-08-11T14:50:00Z', null, 4), ...old], {
      deviceId: 'd',
      code: '13',
      now,
    }).events,
    [],
  );
  assert.equal(validMemory({ seenAt: now + H, issued: '2026-08-11', j1: 2 }, now), undefined);
  assert.deepEqual(validMemory({ seenAt: now, issued: '2026-08-11', j1: 9 }, now).j1, null);
});

const response = (body, init) => new Response(body, init);

test('getFile: ETag sent only when clean, 304, 404, 429 with Retry-After, redirect refused', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init);
    return response(null, { status: 304 });
  };
  assert.deepEqual(
    await getFile('https://x/mdf_2026.csv.gz', { maxBytes: 10, etag: '"ab"', fetchImpl }),
    {
      notModified: true,
    },
  );
  assert.equal(seen[0].headers['If-None-Match'], '"ab"');
  assert.match(seen[0].headers['User-Agent'], /^gladys-meteo-des-forets\/0\.1\.0 \(\+https:/);
  assert.equal(seen[0].redirect, 'error');
  await getFile('https://x/f', { maxBytes: 10, etag: '"a"\r\nX: y', fetchImpl });
  assert.equal(seen[1].headers['If-None-Match'], undefined);
  await assert.rejects(
    getFile('https://x/f', { maxBytes: 10, fetchImpl: async () => response('', { status: 404 }) }),
    { code: 'not_found' },
  );
  await assert.rejects(
    getFile('https://x/f', {
      maxBytes: 10,
      fetchImpl: async () => response('', { status: 429, headers: { 'retry-after': '120' } }),
    }),
    { code: 'rate_limited', retryAfter: 120_000 },
  );
  await assert.rejects(
    getFile('https://x/f', { maxBytes: 10, fetchImpl: async () => response('', { status: 503 }) }),
    { code: 'server' },
  );
  assert.equal(
    retryAfterMs('Wed, 11 Nov 2026 20:00:00 GMT', 'Wed, 11 Nov 2026 19:00:00 GMT'),
    3_600_000,
  );
});

test('getFile: an answer too large is cut, declared or streamed', async () => {
  await assert.rejects(
    getFile('https://x/f', {
      maxBytes: 10,
      fetchImpl: async () => response('x'.repeat(5), { headers: { 'content-length': '11' } }),
    }),
    { code: 'too_large' },
  );
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(8));
      if (pulled > 1000) controller.close();
    },
  });
  await assert.rejects(
    getFile('https://x/f', { maxBytes: 20, fetchImpl: async () => response(stream) }),
    {
      code: 'too_large',
    },
  );
  assert.ok(pulled < 10, `read ${pulled} chunks`);
});

test('getFile: a server that never answers is cut by the timeout', async () => {
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  await assert.rejects(getFile('https://x/f', { maxBytes: 10, timeout: 20, fetchImpl }), {
    code: 'timeout',
  });
});

test('decompress: gzip bounded once opened (a zip bomb), damaged refused, plain CSV taken', async () => {
  const bomb = gzipSync(Buffer.alloc(5_000_000));
  assert.ok(bomb.length < 10_000);
  await assert.rejects(decompress(bomb, 1_000_000), { code: 'too_large' });
  await assert.rejects(decompress(Buffer.from([0x1f, 0x8b, 1, 2, 3])), { code: 'bad_answer' });
  assert.equal(await decompress(gzipSync(Buffer.from('date;é'))), 'date;é');
  assert.equal(await decompress(Buffer.from('date;num_dep')), 'date;num_dep');
});

test('the /data file: missing, written, read back, unreadable kept aside', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mdf-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const store = createFileStore(file);
  assert.equal((await store.load()).state, 'missing');
  await store.save({ a: 1 });
  assert.deepEqual(await store.load(), { data: { a: 1 }, state: 'ok' });
  await writeFile(file, '{broken');
  assert.equal((await store.load()).state, 'unreadable');
  await store.save({ b: 2 });
  assert.equal(await readFile(`${file}.unreadable`, 'utf8'), '{broken');
  assert.deepEqual((await store.load()).data, { b: 2 });
});
