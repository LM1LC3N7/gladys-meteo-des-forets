// -----------------------------------------------------------------------------
// The yearly CSV of the Météo des forêts -> the bulletins of the followed
// departments, and the danger level of a given day. Pure.
//
// One line per department and per bulletin: `date` (time of issue, UTC),
// `num_dep`, `niveau_j1` (level of the next day), `niveau_j2` (the day after),
// `nom_dep`. The files changed from year to year: `;` in 2026, `,` before;
// `01` in 2026, `1` before; `dep_nom` in 2025. The columns are found by their
// name, the separator from the header.
//
// The days are the days of mainland France (Europe/Paris): a bulletin issued
// on the 5th at 16:50 gives the levels of the 6th (J+1) and of the 7th (J+2).
// -----------------------------------------------------------------------------

import { SourceError } from './http.js';
import { KEPT_BULLETINS, LEVEL, MAX_LINES, TIMEZONE } from './constants.js';
import { normalizeDepartment } from './departments.js';

const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const HOUR = 3_600_000;

/** The day in Paris of an instant, `YYYY-MM-DD`. */
export function parisDate(ms) {
  const parts = Object.fromEntries(DAY_FORMAT.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The year in Paris of an instant (the name of the yearly file). */
export const parisYear = (ms) => Number(parisDate(ms).slice(0, 4));

/** `YYYY-MM-DD` moved by `n` days (calendar days, no clock involved). */
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The instant at which the Paris day after the one of `ms` starts. */
export function nextParisMidnight(ms) {
  const next = addDays(parisDate(ms), 1);
  const [y, m, d] = next.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  // Paris is UTC+1 or UTC+2, and never changes its offset at midnight.
  for (const offset of [2, 1]) {
    const at = utcMidnight - offset * HOUR;
    if (parisDate(at) === next && parisDate(at - 1) !== next) return at;
  }
  return utcMidnight - HOUR;
}

/** The instant `minutes` after midnight UTC of the UTC day of `ms`, shifted by `days`. */
export function utcSlot(ms, minutes, days = 0) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days) + minutes * 60_000;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?Z$/;

/** A time of issue: strict ISO UTC, else undefined. */
export function parseIssueTime(text) {
  const match = ISO.exec(String(text ?? '').trim());
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s = '0'] = match;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  // Rejects 2026-02-30 and 25:00 (Date.UTC would roll them over).
  const back = new Date(ms);
  if (back.getUTCDate() !== +d || back.getUTCHours() !== +h || back.getUTCMonth() !== +mo - 1) {
    return undefined;
  }
  return ms;
}

/** A level 1-4, else null (unknown: never 0, never guessed). */
export function parseLevel(text) {
  const value = String(text ?? '').trim();
  if (!/^\d$/.test(value)) return null;
  const n = Number(value);
  return n >= LEVEL.min && n <= LEVEL.max ? n : null;
}

/**
 * The CSV -> `{ byDepartment: Map<code, bulletin[]>, newestAt, lines, unreadable }`.
 * A bulletin is `{ at, issued, j1, j2 }` (`issued`: Paris day of issue; a
 * level unreadable is null); per department, one per day of issue (the
 * latest of the day wins), newest first, KEPT_BULLETINS at most. Only the
 * `wanted` departments are kept; `newestAt` is over every readable line
 * (the season). Lines issued after `notAfter` (a date in the future) are
 * unreadable. Throws a SourceError when the file is not the one expected.
 */
export function parseBulletins(csv, { wanted, notAfter = Infinity } = {}) {
  const text = String(csv ?? '').replace(/^\uFEFF/, '');
  const firstEnd = text.indexOf('\n');
  const header = (firstEnd === -1 ? text : text.slice(0, firstEnd)).replace(/\r$/, '');
  const separator = header.includes(';') ? ';' : ',';
  const names = header.split(separator).map((n) => n.trim().toLowerCase());
  const col = {
    date: names.indexOf('date'),
    dep: names.indexOf('num_dep'),
    j1: names.indexOf('niveau_j1'),
    j2: names.indexOf('niveau_j2'),
  };
  if (Object.values(col).some((i) => i < 0)) {
    throw new SourceError('bad_answer', 'not a Météo des forêts file (columns missing)');
  }
  const want = new Set(wanted ?? []);
  const byDay = new Map();
  let newestAt;
  let lines = 0;
  let unreadable = 0;
  let start = firstEnd === -1 ? text.length : firstEnd + 1;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, '');
    start = end + 1;
    if (line.trim() === '') continue;
    lines += 1;
    if (lines > MAX_LINES) {
      throw new SourceError('too_large', `more than ${MAX_LINES} lines`);
    }
    const cells = line.split(separator);
    const at = parseIssueTime(cells[col.date]);
    const dep = normalizeDepartment(cells[col.dep]);
    if (at === undefined || dep === undefined || at > notAfter) {
      unreadable += 1;
      continue;
    }
    if (newestAt === undefined || at > newestAt) newestAt = at;
    if (!want.has(dep)) continue;
    const bulletin = {
      at,
      issued: parisDate(at),
      j1: parseLevel(cells[col.j1]),
      j2: parseLevel(cells[col.j2]),
    };
    let days = byDay.get(dep);
    if (!days) byDay.set(dep, (days = new Map()));
    const before = days.get(bulletin.issued);
    if (!before || before.at < at) days.set(bulletin.issued, bulletin);
  }
  if (lines > 0 && newestAt === undefined) {
    throw new SourceError('bad_answer', 'no readable line');
  }
  const byDepartment = new Map();
  for (const [dep, days] of byDay) {
    byDepartment.set(dep, newestFirst([...days.values()]));
  }
  return { byDepartment, newestAt, lines, unreadable };
}

/** Bulletins newest first, one per day of issue, KEPT_BULLETINS at most. */
export function newestFirst(list) {
  return [...list].sort((a, b) => b.at - a.at).slice(0, KEPT_BULLETINS);
}

/** A bulletin read back from /data, or undefined. */
export function validBulletin(b, notAfter) {
  if (!b || typeof b !== 'object') return undefined;
  if (!Number.isFinite(b.at) || b.at > notAfter) return undefined;
  const ok = (v) => v === null || (Number.isInteger(v) && v >= LEVEL.min && v <= LEVEL.max);
  if (!ok(b.j1) || !ok(b.j2)) return undefined;
  return { at: b.at, issued: parisDate(b.at), j1: b.j1, j2: b.j2 };
}

/**
 * The level of the Paris day `date` from a department's bulletins: J+1 of
 * the bulletin issued the day before, else J+2 of the one issued two days
 * before. A bulletin of the day before whose level is unreadable makes it
 * unknown (an older forecast never stands in for a newer one). Undefined
 * when no bulletin covers the day.
 */
export function levelOn(bulletins, date) {
  const dayBefore = bulletins.find((b) => b.issued === addDays(date, -1));
  if (dayBefore) {
    return dayBefore.j1 === null ? undefined : { level: dayBefore.j1, bulletin: dayBefore };
  }
  const twoBefore = bulletins.find((b) => b.issued === addDays(date, -2));
  if (twoBefore && twoBefore.j2 !== null) return { level: twoBefore.j2, bulletin: twoBefore };
  return undefined;
}

/** Today, tomorrow and the day after in Paris: `{ today, tomorrow, dayAfter }` (levels or undefined). */
export function levelsAt(bulletins, now) {
  const today = parisDate(now);
  return {
    today: levelOn(bulletins, today)?.level,
    tomorrow: levelOn(bulletins, addDays(today, 1))?.level,
    dayAfter: levelOn(bulletins, addDays(today, 2))?.level,
  };
}

/** In season: a bulletin (any department) issued within `days` Paris days. */
export function inSeason(newestAt, now, days) {
  if (!Number.isFinite(newestAt)) return false;
  return parisDate(newestAt) >= addDays(parisDate(now), -days);
}
