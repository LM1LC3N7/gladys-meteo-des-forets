// -----------------------------------------------------------------------------
// Constants of the Météo des forêts integration. Keys marked "forever" are
// stored in the user's devices, scenes or /data: never renamed.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/**
 * The yearly file of the Météo des forêts bulletins (Météo-France, open data
 * on data.gouv.fr, Licence Ouverte 2.0), one line per department and per
 * bulletin, updated every day of the season. No key.
 */
export const SOURCE_URL = (year) =>
  `https://meteofrance.s3.sbg.io.cloud.ovh.net/data/BULLETIN/MDF/mdf_${year}.csv.gz`;
/** The page of the dataset (docs, status): never read by the code. */
export const DATASET_URL = 'https://www.data.gouv.fr/datasets/archives-de-la-meteo-des-forets';

/** The version of the package (the release bumps it): the User-Agent follows. */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

/** Sent with every request: the server sees who asks. Never a browser's. */
export const USER_AGENT = `gladys-meteo-des-forets/${VERSION} (+https://github.com/LM1LC3N7/gladys-meteo-des-forets)`;

/** The timezone of the bulletins: their days are the days of mainland France. */
export const TIMEZONE = 'Europe/Paris';

/** A request, headers and body, never takes longer. */
export const HTTP_TIMEOUT = 30_000;
/** The compressed file (50 KB for a whole season in 2026) is cut and refused past this. */
export const MAX_GZIP_BYTES = 2 * 1024 * 1024;
/** The file once decompressed (450 KB in 2026): refused past this (a zip bomb). */
export const MAX_CSV_BYTES = 16 * 1024 * 1024;
/** Lines read at most (12,577 in 2026: 96 departments x 132 days). */
export const MAX_LINES = 100_000;

/**
 * The reads, in minutes after midnight UTC. Météo-France issues the bulletin
 * around 14:50 UTC (16:00 UTC in 2024) and the file follows within half an
 * hour: in season, a read at 15:30 UTC, then again later the same day only
 * while the bulletin of the day is missing. Off season (no bulletin for
 * SEASON_DAYS days), one read a day: the first bulletin of the season is seen
 * the day it comes out. Never more often than the source changes.
 */
export const SLOTS = {
  season: [15 * 60 + 30, 16 * 60 + 30, 18 * 60, 20 * 60 + 30],
  offSeason: [17 * 60 + 30],
};
/** In season: a bulletin issued within this many days (Paris days). */
export const SEASON_DAYS = 3;
/** Two requests are never closer than this (restart, Test button, configuration). */
export const MIN_GAP = 20 * 60_000;
/** A pause asked by the server (429, 5xx): at least, and at most. */
export const PAUSE = { min: 20 * 60_000, max: 6 * 3_600_000 };
/** The timer never sleeps longer: the clocks are read again at each wake-up. */
export const MAX_SLEEP = 15 * 60_000;
/** getConfig() failing: retried, the delay doubled from min up to max, never given up. */
export const CONFIG_RETRY = { min: 5_000, max: 300_000 };
/** /data never holds a read, a start or a stop longer than this. */
export const SAVE_WAIT = 5_000;
/** stop() waits this long at most for the read running. */
export const STOP_WAIT = 4_000;
/** A scene event only for a bulletin issued less than this long ago. */
export const EVENT_MAX_AGE = 24 * 3_600_000;
/** Departments followed at most. */
export const MAX_DEPARTMENTS = 10;
/** Bulletins kept per department in /data (the days of the three features). */
export const KEPT_BULLETINS = 4;
/** Texts sent to Gladys are cut past this many characters. */
export const LIMITS = { state: 200, status: 900 };

/** Danger levels of the Météo des forêts: 1 low ... 4 very high. */
export const LEVEL = { min: 1, max: 4 };

/** Manifest action key (forever). */
export const ACTIONS = { TEST: 'test_connection' };
/** Manifest scene trigger key (forever). */
export const SCENE_TRIGGERS = { RAISED: 'fire_danger_forecast' };
/** Languages of the device names and texts. */
export const LANGUAGES = ['fr', 'en'];
