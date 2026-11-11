// -----------------------------------------------------------------------------
// A new bulletin of a department -> the scene events "fire danger forecast
// reaches a level", and the memory carried to the next read (kept in /data).
// Pure. Nothing fires on the first read of a department, nor for a bulletin
// older than EVENT_MAX_AGE (found late, after an outage).
// -----------------------------------------------------------------------------

import { EVENT_MAX_AGE, LEVEL, SCENE_TRIGGERS } from './constants.js';
import { addDays, levelOn } from './bulletin.js';
import { levelName } from './i18n.js';

const level = (v) => Number.isInteger(v) && v >= LEVEL.min && v <= LEVEL.max;

/** A memory read back from /data, or undefined. */
export function validMemory(memory, now) {
  if (!memory || typeof memory !== 'object') return undefined;
  if (!Number.isFinite(memory.seenAt) || memory.seenAt > now) return undefined;
  if (typeof memory.issued !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(memory.issued)) {
    return undefined;
  }
  return { seenAt: memory.seenAt, issued: memory.issued, j1: level(memory.j1) ? memory.j1 : null };
}

/**
 * `bulletins`: the department's, newest first. The level of tomorrow (J+1 of
 * the new bulletin) is compared with the level of the day of issue (the
 * older bulletins): one event per level crossed, 2 to 4. No bulletin for the
 * day of issue (the first of the season) counts as low (1). A bulletin
 * issued again the same day (a correction) is compared with the one already
 * seen that day: never twice for the same rise.
 */
export function departmentEvents(memory, bulletins, { deviceId, code, language = 'fr', now }) {
  const newest = bulletins[0];
  // Read, without any bulletin (off season): remembered as such, so that the
  // first bulletin of the season is a change, never a first read.
  if (!newest)
    return { events: [], memory: memory ?? { seenAt: 0, issued: '1970-01-01', j1: null } };
  const next = { seenAt: newest.at, issued: newest.issued, j1: newest.j1 };
  if (!memory) return { events: [], memory: next };
  if (newest.at <= memory.seenAt) return { events: [], memory };
  if (newest.j1 === null || now - newest.at > EVENT_MAX_AGE || newest.at > now) {
    return { events: [], memory: next };
  }
  const before =
    memory.issued === newest.issued
      ? memory.j1
      : (levelOn(bulletins.slice(1), newest.issued)?.level ?? LEVEL.min);
  if (!level(before)) return { events: [], memory: next };
  const events = [];
  for (let l = Math.max(2, before + 1); l <= newest.j1; l += 1) {
    events.push({
      key: SCENE_TRIGGERS.RAISED,
      data: {
        department: deviceId,
        level: String(l),
        current_level: newest.j1,
        level_name: levelName(newest.j1, language),
        previous_level: before,
        day_after_level: newest.j2 ?? null,
        department_code: code,
        forecast_date: addDays(newest.issued, 1),
        bulletin_at: new Date(newest.at).toISOString(),
      },
    });
  }
  return { events, memory: next };
}
