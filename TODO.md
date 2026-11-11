# TODO

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`
  `ghcr.io/lm1lc3n7/gladys-meteo-des-forets:0.1.0`), SDK `^0.16.0` (latest
  published on 2026-11-11).
- No `keywords` nor `countries` in the manifest (the store rule): France would
  fit `countries` when the store allows it. One category: `environment`.
- Source: the yearly file `mdf_<year>.csv.gz` of the dataset "Archives de la
  Météo des forêts" (data.gouv.fr, Licence Ouverte 2.0), the only machine
  readable form found: updated every day of the season (2026: 28 May to
  5 October, 132 bulletins, Last-Modified ~25 min after the bulletin). No
  library to reuse (nothing to port): written from the file and the
  presentation PDF of the dataset. The format changed every year (`;` and `01`
  in 2026, `,` and `1` before, `dep_nom` in 2025, 16:00 UTC in 2024): the
  columns are found by name, the separator from the header.
- Features: today and tomorrow (Paris days), not "J+1/J+2 of the latest
  bulletin": a scene at 8 a.m. wants today's level, which is J+1 of
  yesterday's bulletin. The day after tomorrow is not a feature: it is unknown
  every morning until the new bulletin (Gladys cannot clear a value, so it
  would show the J+2 of another day); it is in the bulletin text and in the
  trigger variables.
- Off season the last values stay in Gladys (no way to clear them); the
  bulletin text says "no bulletin" with the date of the last one, the status
  too. Nothing is ever published as 0.
- Departments typed as codes (`13, 83, 2A`), not a `multi_select` of 96
  checkboxes, nor the house position (would need the department outlines,
  1 MB): simpler, documented.
- Reads: slots 15:30, 16:30, 18:00, 20:30 UTC in season, none on a Paris day
  whose bulletin is held; 17:30 UTC once a day off season (no bulletin for 3
  days); a missed slot is caught up at start; MIN_GAP 20 min on both clocks
  (monotonic too: a wall clock set back or forward makes no storm); 429/5xx
  pause 20 min doubled up to 6 h, Retry-After honored, kept in /data. ETag sent
  only when the cache covers every followed department for the file of this
  year. 404 (the file of the new year does not exist yet): "no bulletin yet",
  remembered for the departments asked, not an error.
- Trigger "fire_danger_forecast": J+1 of a new bulletin against the level of
  its day of issue (older bulletins), no bulletin that day = low (1): the first
  bulletin of the season at "moderate" fires. One event per level crossed (the
  core matches the select exactly, as gladys-feux-canada). Never at the first
  read, never for a bulletin over 24 h old, a correction the same day compared
  with the one seen. Memory in /data, written before the events are sent.
- Values published only when they changed, the last ones kept in /data: a
  restart or a reconnection republishes nothing (no duplicate history point
  that would wake a scene); a device created gets its values at once from the
  bulletins kept, without a request.
- /data: read with a bound (5 s), again every 10 s while unreadable (no read
  of the source, no write meanwhile), given up after 6 tries (the store keeps
  the file aside before replacing it); one write at a time, bounded wait, the
  newest state written after a slow one.

- r1: every failure but the 404 (429, 5xx, 403, a file not understood, the
  network) gives a backoff of 20 min doubled up to 6 h, Retry-After honored,
  kept in /data and ended only by a usable answer (I1). A device created after
  a read gets its trigger memory from the bulletins kept (M3). A line over
  4 KB is unreadable (M6); at the same second the later line wins (M5). A
  correction after the read of the day is read the next day (M4, documented).

## Later

- `countries: ["FR"]` when the store accepts it.
- The department from the house position (outlines of data.gouv.fr), if asked.
