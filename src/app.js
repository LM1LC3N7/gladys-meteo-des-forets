// -----------------------------------------------------------------------------
// The integration: one device per followed department offered in Discovery,
// the yearly file of the Météo des forêts read at the times the bulletin comes
// out (never more often), the levels of today and tomorrow published (again
// at each Paris midnight, from the bulletins kept), the
// scene events, the status and the Test button. index.js only wires the SDK
// to it. Read only: nothing is ever commanded.
//
// Two clocks: `now` (wall clock) places the reads at the times of the source
// and dates what /data keeps; `monotonic` keeps two requests MIN_GAP apart
// and paces the pauses, so that a wall clock set back or forward never makes
// a storm of requests. Each decision reads each clock once.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  CONFIG_RETRY,
  MAX_SLEEP,
  MIN_GAP,
  PAUSE,
  SAVE_WAIT,
  SEASON_DAYS,
  SLOTS,
  SOURCE_URL,
  STOP_WAIT,
} from './constants.js';
import {
  addDays,
  inSeason,
  levelsAt,
  newestFirst,
  nextParisMidnight,
  parisDate,
  parisYear,
  parseBulletins,
  utcSlot,
  validBulletin,
} from './bulletin.js';
import { DEPARTMENTS } from './departments.js';
import { FEATURE, buildDepartmentDevice, ids, parseExternalId } from './devices.js';
import { T, bulletinText, departmentLabel, joinLines } from './i18n.js';
import { SourceError } from './http.js';
import { ForestSource } from './source.js';
import { createFileStore } from './store.js';
import { departmentEvents, validMemory } from './triggers.js';

const defaultTimers = { setTimeout, clearTimeout };
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** /data unreadable or slow at the start: read again every DATA_RETRY, given up after DATA_TRIES. */
const DATA_RETRY = 10_000;
const DATA_TRIES = 6;
/** A date of /data later than now by more than this is not believed. */
const FUTURE_SLACK = 60_000;

/** A pause read back from /data: `{ until, count, status }`, ending at a monotonic `due` too. */
function validPause(pause, now, mono) {
  if (!pause || !finite(pause.until) || !Number.isInteger(pause.count) || pause.count < 1) {
    return undefined;
  }
  const left = Math.min(Math.max(0, pause.until - now), PAUSE.max);
  if (left === 0) return undefined;
  return {
    until: now + left,
    due: mono + left,
    count: Math.min(pause.count, 16),
    status: Number.isInteger(pause.status) ? pause.status : null,
    // 'server' (429/5xx asked to wait) or 'error' (any other failure: backoff).
    kind: pause.kind === 'error' ? 'error' : 'server',
    message: typeof pause.message === 'string' ? pause.message.slice(0, 120) : undefined,
  };
}

/** The cache read back from /data, or an empty one. */
function validCache(cache, now) {
  const empty = { url: undefined, etag: undefined, deps: [], newestAt: undefined, bulletins: {} };
  if (!cache || typeof cache !== 'object') return empty;
  const bulletins = {};
  for (const [code, list] of Object.entries(cache.bulletins ?? {})) {
    if (!DEPARTMENTS.has(code) || !Array.isArray(list)) continue;
    bulletins[code] = newestFirst(
      list.map((b) => validBulletin(b, now + FUTURE_SLACK)).filter(Boolean),
    );
  }
  const deps = Array.isArray(cache.deps) ? cache.deps.filter((d) => DEPARTMENTS.has(d)) : [];
  const newestAt =
    finite(cache.newestAt) && cache.newestAt <= now + FUTURE_SLACK ? cache.newestAt : undefined;
  return {
    url: typeof cache.url === 'string' && cache.url.length < 300 ? cache.url : undefined,
    etag: typeof cache.etag === 'string' && cache.etag.length <= 210 ? cache.etag : undefined,
    // Without the newest date, the ETag would hold a cache it cannot vouch for.
    deps: newestAt === undefined ? [] : deps,
    newestAt,
    bulletins,
  };
}

export class ForestApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'meteo-des-forets' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    store = createFileStore(),
    source,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.source = source ?? new ForestSource({ timers });
    this.config = normalizeConfig();
    this.running = false;
    this.session = undefined;
    this.timer = undefined;
    this.busy = undefined;
    this.loopRun = Promise.resolve();
    this.lifecycle = Promise.resolve();
    this.lastStatus = undefined;
    this.generation = 0;
    this.configRetry = undefined;
    /** The outcome of the last read: `{ kind: 'ok' | 'noFile' | 'error' | 'paused', ... }`. */
    this.outcome = undefined;
    // /data: loaded at the first start (bounded), read again on a timer while unreadable.
    this.data = 'pending'; // 'pending' | 'loaded' | 'given-up'
    this.dataTries = 0;
    this.dataLoad = undefined;
    this.dataTimer = undefined;
    this.dataProblem = undefined;
    this.lastAttemptAt = undefined;
    this.lastAttemptMono = undefined;
    this.pause = undefined;
    this.cache = validCache(undefined, 0);
    this.memories = new Map();
    this.published = new Map();
    /** The Paris day of the levels last published (a new day publishes them again). */
    this.levelsDay = undefined;
  }

  // --- /data -----------------------------------------------------------------------

  /** Takes what /data kept (once, at the first readable load). */
  adopt(kept) {
    const at = this.now();
    const mono = this.monotonic();
    this.pause = validPause(kept.pause, at, mono);
    // A date in the future (a clock set back) is brought to now: the next read
    // is never pushed away for ever, never sooner either.
    if (finite(kept.lastAttemptAt)) {
      this.lastAttemptAt = Math.min(kept.lastAttemptAt, at);
      this.lastAttemptMono = mono - (at - this.lastAttemptAt);
    }
    this.cache = validCache(kept.cache, at);
    this.memories = new Map();
    for (const [id, memory] of Object.entries(kept.memories ?? {})) {
      const valid = parseExternalId(id) && validMemory(memory, at + FUTURE_SLACK);
      if (valid) this.memories.set(id, valid);
    }
    this.published = new Map();
    for (const [id, value] of Object.entries(kept.published ?? {})) {
      if (typeof value === 'number' || (typeof value === 'string' && value.length <= 300)) {
        this.published.set(id, value);
      }
    }
  }

  /** One load of /data, SAVE_WAIT at most; a load still running is never doubled. */
  async loadData() {
    if (this.data !== 'pending') return;
    if (!this.dataLoad) {
      this.dataLoad = Promise.resolve()
        .then(() => this.store.load())
        .then(
          (r) => r,
          () => ({ state: 'unreadable' }),
        )
        .finally(() => {
          this.dataLoad = undefined;
        });
    }
    let timer;
    const result = await Promise.race([
      this.dataLoad,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve({ state: 'slow' }), SAVE_WAIT);
      }),
    ]);
    this.timers.clearTimeout(timer);
    if (this.data !== 'pending') return;
    this.dataTries += 1;
    if (result.state === 'ok' || result.state === 'missing') {
      this.adopt(result.data ?? {});
      this.data = 'loaded';
      this.dataProblem = undefined;
      return;
    }
    this.dataProblem = 'unreadable';
    if (this.dataTries >= DATA_TRIES) {
      // Given up: the session goes on with an empty memory (the file is kept
      // aside by the store before the first save replaces it).
      this.logger.warn('/data unreadable: going on without it');
      this.data = 'given-up';
      return;
    }
    if (this.dataTimer === undefined) {
      this.dataTimer = this.timers.setTimeout(() => {
        this.dataTimer = undefined;
        this.loadData()
          .then(() => this.schedule())
          .catch(() => {});
      }, DATA_RETRY);
    }
  }

  /**
   * Writes /data, waiting SAVE_WAIT at most: a frozen /data never holds a
   * read, a start or a stop. One write at a time: while one is still running,
   * the newest state is written after it, never a second wait. Never while
   * /data is still being read (it would replace what could not be read yet).
   * Resolves true when written.
   */
  async saveState() {
    if (this.data === 'pending') return false;
    if (this.writing) {
      this.writeAgain = true;
      return false;
    }
    const snapshot = {
      lastAttemptAt: this.lastAttemptAt,
      pause: this.pause && {
        until: this.pause.until,
        count: this.pause.count,
        status: this.pause.status,
        kind: this.pause.kind,
        message: this.pause.message,
      },
      cache: this.cache,
      memories: Object.fromEntries(this.memories),
      published: Object.fromEntries(this.published),
    };
    const job = Promise.resolve()
      .then(() => this.store.save(snapshot))
      .then(
        () => true,
        (err) => err ?? new Error('save failed'),
      );
    this.writing = job;
    job.then((result) => {
      this.writing = undefined;
      if (result === true) {
        if (this.dataProblem !== 'unreadable' || this.data === 'loaded') {
          this.dataProblem = undefined;
        }
      } else {
        this.dataProblem = 'unwritable';
        this.logger.warn(`/data not written (${result?.code ?? result?.message ?? 'error'})`);
      }
      if (this.writeAgain) {
        this.writeAgain = false;
        this.saveState().catch(() => {});
      }
    });
    let timer;
    const result = await Promise.race([
      job,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve('slow'), SAVE_WAIT);
      }),
    ]);
    this.timers.clearTimeout(timer);
    if (result === 'slow') {
      this.dataProblem = 'frozen';
      this.logger.warn('/data not written in time');
      return false;
    }
    return result === true;
  }

  // --- Lifecycle -------------------------------------------------------------

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /** Resolves once every queued start/stop and the read running are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.loopRun;
    await this.busy;
  }

  /**
   * The SDK is connected: the configuration, then the start. getConfig()
   * failing is retried, the delay doubled up to CONFIG_RETRY.max, never given
   * up, with the status saying so.
   */
  connected(getConfig) {
    this.cancelConfigRetry();
    const generation = ++this.generation;
    let attempt = 0;
    const tryOnce = async () => {
      this.configRetry = undefined;
      if (generation !== this.generation) return;
      attempt += 1;
      let config;
      try {
        config = await getConfig();
      } catch (err) {
        if (generation !== this.generation) return;
        this.logger.warn(`getConfig failed (${err?.status ?? err?.name ?? 'error'}), retrying`);
        this.lastStatus = undefined;
        await this.setStatus(false, T.waitingConfig(attempt));
        if (generation !== this.generation) return;
        const delay = Math.min(CONFIG_RETRY.max, CONFIG_RETRY.min * 2 ** (attempt - 1));
        this.configRetry = this.timers.setTimeout(() => {
          this.configRun = tryOnce();
        }, delay);
        return;
      }
      if (generation !== this.generation) return;
      await this.start(config);
    };
    this.configRun = tryOnce();
    return this.configRun;
  }

  cancelConfigRetry() {
    if (this.configRetry !== undefined) {
      this.timers.clearTimeout(this.configRetry);
      this.configRetry = undefined;
    }
  }

  start(raw = {}) {
    this.cancelConfigRetry();
    // A getConfig() still running for an older connection gives up.
    this.generation += 1;
    return this.serialize(() => this.doStart(raw));
  }

  /** Stops the reads, waits (bounded) for the one running, and writes /data. */
  stop() {
    this.cancelConfigRetry();
    this.generation += 1;
    return this.serialize(async () => {
      this.doStop();
      if (this.dataTimer !== undefined) {
        this.timers.clearTimeout(this.dataTimer);
        this.dataTimer = undefined;
      }
      const running = this.busy;
      let timer;
      await Promise.all([
        this.saveState(),
        running &&
          Promise.race([
            running.catch(() => {}),
            new Promise((resolve) => {
              timer = this.timers.setTimeout(resolve, STOP_WAIT);
            }),
          ]),
      ]);
      this.timers.clearTimeout(timer);
      if (running) await this.saveState();
    });
  }

  async doStart(raw) {
    this.doStop();
    this.config = normalizeConfig(raw);
    this.running = true;
    const session = (this.session = {});
    await this.loadData();
    if (session !== this.session) return;
    // The core keeps the status and the Discovery list in memory: a restarted
    // Gladys has lost them, so they are sent again.
    this.lastStatus = undefined;
    await this.publishDiscovery();
    if (session !== this.session) return;
    // The levels of today from the bulletins kept: only what changed since the
    // last publication (kept in /data), never an old value as new.
    await this.publishLevels();
    if (session !== this.session) return;
    await this.updateStatus();
    this.schedule();
  }

  doStop() {
    this.running = false;
    this.session = undefined;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err?.message}`));
  }

  // --- Discovery and devices ---------------------------------------------------------

  async publishDiscovery() {
    const devices = this.config.departments.map((code) =>
      buildDepartmentDevice(this.gladys, code, this.config.language),
    );
    try {
      await this.gladys.publishDiscoveredDevices(devices);
    } catch (err) {
      this.logger.warn(`Discovery not published: ${err?.message}`);
    }
  }

  /** Scan asked by the user: the departments of the configuration, never a read of the source. */
  async scan() {
    await this.publishDiscovery();
    await this.updateStatus();
  }

  /** The created devices: `{ deviceId, code, name, followed }`. */
  targets() {
    const list = [];
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseExternalId(device?.external_id);
      if (!parsed) continue;
      list.push({
        deviceId: device.external_id,
        code: parsed.code,
        name: device.name ?? departmentLabel(parsed.code),
        followed: this.config.departments.includes(parsed.code),
      });
    }
    return list;
  }

  /** A device created (or changed): its levels at once, from the bulletins kept. */
  async deviceChanged(device) {
    if (!this.running) return;
    const id = device?.external_id;
    if (parseExternalId(id)) {
      for (const key of Object.values(FEATURE)) this.published.delete(ids.feature(id, key));
    }
    // A department newly created may be missing from the cache: read when due.
    await this.publishLevels();
    await this.updateStatus();
    this.schedule();
  }

  async deviceDeleted(device) {
    const id = device?.external_id;
    let changed = this.memories.delete(id);
    for (const key of Object.values(FEATURE)) {
      changed = this.published.delete(ids.feature(id, key)) || changed;
    }
    if (changed) await this.saveState();
    await this.updateStatus();
  }

  // --- Pace ------------------------------------------------------------------

  pauseLeft(mono) {
    return this.pause ? Math.min(Math.max(0, this.pause.due - mono), PAUSE.max) : 0;
  }

  /** The followed departments the cache does not hold for the file of this year. */
  missing(now) {
    const url = SOURCE_URL(parisYear(now));
    if (this.cache.url !== url) return this.config.departments;
    return this.config.departments.filter((d) => !this.cache.deps.includes(d));
  }

  /**
   * The next slot of the source after the last attempt (a missed one comes
   * back at once): none on a Paris day whose bulletin is already held.
   */
  nextSlot(now) {
    const slots = inSeason(this.cache.newestAt, now, SEASON_DAYS) ? SLOTS.season : SLOTS.offSeason;
    const heldDay = finite(this.cache.newestAt) ? parisDate(this.cache.newestAt) : '';
    const after = this.lastAttemptAt ?? -Infinity;
    for (let d = -1; d <= 2; d += 1) {
      for (const minutes of slots) {
        const at = utcSlot(now, minutes, d);
        if (at <= after) continue;
        if (parisDate(at) <= heldDay) continue;
        return at;
      }
    }
    return utcSlot(now, slots[0], 3);
  }

  /**
   * The wall time from which the next read may start, from the caller's
   * readings `now` and `mono` (read once). Nothing is due without a
   * department, nor while /data is still being read.
   */
  dueAt(now, mono) {
    if (this.config.departments.length === 0 || this.data === 'pending') return Infinity;
    let due = this.missing(now).length > 0 ? now : this.nextSlot(now);
    if (this.lastAttemptMono !== undefined) {
      due = Math.max(due, now + (this.lastAttemptMono + MIN_GAP - mono));
    }
    return Math.max(due, now + this.pauseLeft(mono));
  }

  schedule() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.running) return;
    const now = this.now();
    const mono = this.monotonic();
    const due = this.dueAt(now, mono);
    const midnight = nextParisMidnight(now) + 1_000;
    const wait = Math.max(0, Math.min(due - now, midnight - now, MAX_SLEEP));
    const session = this.session;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.loopRun = this.loop(session);
    }, wait);
  }

  /** The timer: a new Paris day publishes the levels again; a due read is made. */
  async loop(session) {
    try {
      await this.wake();
    } catch (err) {
      this.logger.error(`Unexpected error (${err?.name ?? 'Error'}: ${err?.message})`);
    }
    if (session === this.session && this.running) this.schedule();
  }

  async wake() {
    if (!this.running) return;
    const now = this.now();
    const mono = this.monotonic();
    if (parisDate(now) !== this.levelsDay) await this.publishLevels(now);
    if (now >= this.dueAt(now, mono)) await this.tick();
    else await this.updateStatus();
  }

  /** One read; a read running is never doubled. */
  tick() {
    if (!this.busy) {
      this.busy = this.read().finally(() => {
        this.busy = undefined;
      });
    }
    return this.busy;
  }

  // --- Reading -------------------------------------------------------------------

  async read() {
    const session = this.session;
    if (!session || !this.running) return;
    const gone = () => session !== this.session || !this.running;
    const now = this.now();
    const mono = this.monotonic();
    if (now < this.dueAt(now, mono)) return;
    const url = SOURCE_URL(parisYear(now));
    const wanted = [...this.config.departments];
    const complete = this.missing(now).length === 0;
    // Kept BEFORE the request: a restart during it never reads sooner.
    this.lastAttemptAt = now;
    this.lastAttemptMono = mono;
    await this.saveState();
    if (gone()) return;
    let answer;
    try {
      answer = await this.source.read(url, { etag: complete ? this.cache.etag : undefined });
    } catch (err) {
      if (gone()) return;
      await this.failed(err, now, mono, { url, wanted });
      return;
    }
    if (gone()) return;
    if (answer.notModified) {
      this.outcome = { kind: 'ok', at: now, unreadable: this.outcome?.unreadable ?? 0 };
    } else {
      let parsed;
      try {
        parsed = parseBulletins(answer.csv, { wanted, notAfter: now + FUTURE_SLACK });
      } catch (err) {
        await this.failed(err, now, mono, { url, wanted });
        return;
      }
      const bulletins = {};
      for (const code of wanted) bulletins[code] = parsed.byDepartment.get(code) ?? [];
      this.cache = {
        url,
        etag: answer.etag,
        deps: wanted,
        newestAt: parsed.newestAt,
        bulletins,
      };
      this.outcome = { kind: 'ok', at: now, unreadable: parsed.unreadable };
      if (parsed.unreadable > 0) {
        this.logger.warn(`${parsed.unreadable} unreadable line(s) ignored`);
      }
    }
    // A usable answer ends the backoff (never before the file is read).
    this.pause = undefined;
    this.logger.info(
      `Read: newest bulletin ${finite(this.cache.newestAt) ? new Date(this.cache.newestAt).toISOString() : 'none'}`,
    );
    await this.publishLevels(this.now(), { events: true });
    if (gone()) return;
    await this.saveState();
    await this.updateStatus();
  }

  /** A read that failed: a pause on 429/5xx, said in the status; a 404 is the off season. */
  async failed(err, now, mono, { url, wanted }) {
    const code = err instanceof SourceError ? err.code : 'error';
    if (code === 'not_found') {
      // The file of the year does not exist yet (January to May): no bulletin,
      // not an error. Known as such for the departments asked (the bulletins of
      // the year before stay, for the date of the last one): read again at the
      // next slot only, never in a loop.
      const bulletins = { ...this.cache.bulletins };
      for (const code of wanted) bulletins[code] ??= [];
      this.cache = { ...this.cache, url, etag: undefined, deps: wanted, bulletins };
      this.pause = undefined;
      this.outcome = { kind: 'noFile', at: now, year: parisYear(now) };
      this.logger.info(`No file for ${parisYear(now)} yet (off season)`);
      await this.publishLevels(this.now(), { events: true });
    } else {
      // Any other failure (429, 5xx, 403, a file not understood, the network):
      // a backoff of 20 min doubled up to 6 h, kept in /data, the Retry-After
      // honored. Never a read every MIN_GAP while the cache stays empty.
      const server = code === 'rate_limited' || code === 'server';
      const count = (this.pause?.count ?? 0) + 1;
      const doubled = PAUSE.min * 2 ** Math.min(count - 1, 8);
      const wait = Math.min(PAUSE.max, Math.max(doubled, err.retryAfter ?? 0));
      const message = String(err?.message ?? code).slice(0, 120);
      this.pause = {
        until: now + wait,
        due: mono + wait,
        count,
        status: err.status ?? null,
        kind: server ? 'server' : 'error',
        message,
      };
      this.outcome = server
        ? { kind: 'paused', at: now, status: err.status ?? null }
        : { kind: 'error', at: now, message };
      this.logger.warn(`Read failed (${message}): next try in ${Math.round(wait / 60_000)} min`);
    }
    await this.saveState();
    await this.updateStatus();
  }

  // --- States and events ---------------------------------------------------------------

  /**
   * The states of the created devices of the followed departments, from the
   * bulletins kept: a level only when a bulletin covers the day (unknown stays
   * unknown, never 0), only what changed since the last publication. With
   * `events`, the scene events of the new bulletins.
   */
  async publishLevels(now = this.now(), { events = false } = {}) {
    const today = parisDate(now);
    this.levelsDay = today;
    const season = inSeason(this.cache.newestAt, now, SEASON_DAYS);
    const states = [];
    const fired = [];
    let memoriesChanged = false;
    for (const target of this.targets()) {
      if (!target.followed) continue;
      const bulletins = this.cache.bulletins[target.code];
      if (!bulletins) continue;
      const levels = levelsAt(bulletins, now);
      const put = (key, value) => {
        if (value === undefined) return;
        const id = ids.feature(target.deviceId, key);
        if (this.published.get(id) === value) return;
        states.push(
          typeof value === 'string'
            ? { device_feature_external_id: id, text: value }
            : { device_feature_external_id: id, state: value },
        );
      };
      put(FEATURE.TODAY, levels.today);
      put(FEATURE.TOMORROW, levels.tomorrow);
      const newest = bulletins[0];
      const recent = newest && newest.issued >= addDays(today, -SEASON_DAYS);
      const kind =
        recent && newest.j1 !== null && newest.j2 !== null
          ? 'recent'
          : season
            ? 'missing'
            : 'offSeason';
      put(
        FEATURE.BULLETIN,
        bulletinText(
          {
            kind,
            bulletin: newest,
            j1Date: newest && addDays(newest.issued, 1),
            j2Date: newest && addDays(newest.issued, 2),
          },
          this.config.language,
        ),
      );
      if (!events && !this.memories.has(target.deviceId) && this.cache.deps.includes(target.code)) {
        // A device created after a read: its memory starts from the bulletins
        // kept (no event), so that the next rise is announced.
        const { memory } = departmentEvents(undefined, bulletins, {
          deviceId: target.deviceId,
          now,
        });
        this.memories.set(target.deviceId, memory);
        memoriesChanged = true;
      }
      if (events) {
        const { events: list, memory } = departmentEvents(
          this.memories.get(target.deviceId),
          bulletins,
          { deviceId: target.deviceId, code: target.code, language: this.config.language, now },
        );
        if (memory && memory !== this.memories.get(target.deviceId)) {
          this.memories.set(target.deviceId, memory);
          memoriesChanged = true;
        }
        fired.push(...list);
      }
    }
    if (states.length > 0) {
      try {
        for (let i = 0; i < states.length; i += 100) {
          await this.gladys.publishStates(states.slice(i, i + 100));
        }
        for (const s of states) this.published.set(s.device_feature_external_id, s.text ?? s.state);
        memoriesChanged = true;
      } catch (err) {
        this.logger.warn(`States not published: ${err?.message}`);
        // Sent again at the next wake-up of the timer (same day): never lost.
        this.levelsDay = undefined;
      }
    }
    // The memory first: a restart in between never fires the same rise twice.
    if (memoriesChanged) await this.saveState();
    for (const event of fired) {
      await this.gladys
        .publishSceneEvent(event.key, event.data)
        .catch((err) => this.logger.warn(`Scene event ${event.key} failed: ${err?.message}`));
    }
  }

  // --- Status --------------------------------------------------------------------

  async updateStatus() {
    if (!this.running) return;
    const now = this.now();
    const mono = this.monotonic();
    const { departments, invalid, tooMany } = this.config;
    const lines = [];
    if (this.dataProblem) lines.push(T.data[this.dataProblem]);
    if (invalid.length > 0) lines.push(T.invalid(invalid));
    if (tooMany) lines.push(T.tooMany);
    if (departments.length === 0) {
      await this.setStatus(false, joinLines([T.noDepartment, ...lines]));
      return;
    }
    const due = this.dueAt(now, mono);
    const next = finite(due) ? Math.max(due, now) : undefined;
    if (this.pause?.kind === 'server' && this.pauseLeft(mono) > 0) {
      await this.setStatus(
        false,
        joinLines([T.paused(now + this.pauseLeft(mono), this.pause.status ?? 429), ...lines]),
      );
      return;
    }
    const targets = this.targets();
    const created = new Set(targets.map((t) => t.code));
    const toCreate = departments.filter((d) => !created.has(d));
    const orphans = targets.filter((t) => !t.followed).map((t) => t.name);
    let connected = true;
    const outcome =
      this.outcome ??
      (this.pause?.kind === 'error'
        ? { kind: 'error', message: this.pause.message ?? '?' }
        : undefined);
    if (outcome?.kind === 'error') {
      connected = false;
      lines.unshift(T.failed(outcome.message, next ?? now));
    } else if (outcome?.kind === 'paused') {
      // The pause is over, the next read not made yet.
      connected = false;
      lines.unshift(T.failed(`HTTP ${outcome.status ?? '5xx'}`, next ?? now));
    } else if (outcome?.kind === 'noFile') {
      lines.push(T.noFile(outcome.year));
    } else if (outcome?.kind === 'ok' || (!outcome && this.cache.url)) {
      // Not read yet in this session: what /data kept is said (a restart).
      if (inSeason(this.cache.newestAt, now, SEASON_DAYS))
        lines.push(T.bulletin(this.cache.newestAt));
      else lines.push(T.offSeason(this.cache.newestAt));
      if (outcome?.unreadable > 0) lines.push(T.unreadableLines(outcome.unreadable));
    } else {
      lines.push(T.notRead);
    }
    if (next !== undefined && outcome?.kind !== 'error' && outcome?.kind !== 'paused') {
      lines.push(T.next(next));
    }
    if (toCreate.length > 0) lines.push(T.notCreated(toCreate.map(departmentLabel)));
    if (orphans.length > 0) lines.push(T.orphans(orphans));
    lines.push(T.caveat);
    await this.setStatus(connected, joinLines(lines));
  }

  // --- Test button ------------------------------------------------------------------

  /** A read when one is due (never sooner), else the outcome of the last one and the next time. */
  async testConnection() {
    if (!this.running) return T.notStarted;
    const now = this.now();
    const mono = this.monotonic();
    if (now >= this.dueAt(now, mono)) {
      await this.tick();
      this.schedule();
    }
    await this.updateStatus();
    const status = this.lastStatus ? JSON.parse(this.lastStatus)[1] : undefined;
    return status ?? T.notRead;
  }
}
