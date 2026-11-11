// -----------------------------------------------------------------------------
// The mutants the tests must kill: each one breaks a guard of the code; the
// suite (`node --test test/*.test.js`) must then fail. The unmodified suite
// runs first ("baseline FAILED" and exit 1 when it is red). One mutant at a
// time, in a copy of the repository made in a fresh temporary directory
// (`.git` left out, `node_modules` copied, never linked; removed after), the
// repository itself never touched; each run bounded in time (its whole
// process group killed past the deadline).
//
// Usage: node scripts/mutants.mjs [name filter]   (wrap it in memcap on a dev VM)
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DEADLINE = 300_000;

const A = 'src/app.js';
const B = 'src/bulletin.js';
const TR = 'src/triggers.js';

export const MUTANTS = [
  // Pace: never more often than the source, never a storm.
  [
    'MIN_GAP on the monotonic clock',
    A,
    'due = Math.max(due, now + (this.lastAttemptMono + MIN_GAP - mono));',
    'void mono;',
  ],
  ['no slot on a day whose bulletin is held', A, 'if (parisDate(at) <= heldDay) continue;', ''],
  ['pause honored', A, 'return Math.max(due, now + this.pauseLeft(mono));', 'return due;'],
  ['Retry-After honored', A, 'Math.max(doubled, err.retryAfter ?? 0)', 'doubled'],
  ['pause kept across a restart', A, 'this.pause = validPause(kept.pause, at, mono);', ''],
  [
    'attempt in /data before the request',
    A,
    '    this.lastAttemptMono = mono;\n    await this.saveState();',
    '    this.lastAttemptMono = mono;',
  ],
  [
    '404 remembered (no loop)',
    A,
    'this.cache = { ...this.cache, url, etag: undefined, deps: wanted, bulletins };',
    '',
  ],
  [
    'ETag only for a complete cache',
    A,
    'etag: complete ? this.cache.etag : undefined',
    'etag: this.cache.etag',
  ],
  [
    'getConfig retried with a delay',
    A,
    'CONFIG_RETRY.min * 2 ** (attempt - 1)',
    'CONFIG_RETRY.max * 2 ** (attempt - 1)',
  ],
  // Publication.
  ['Paris midnight publishes again', A, 'if (parisDate(now) !== this.levelsDay)', 'if (false)'],
  ['only what changed', A, 'if (this.published.get(id) === value) return;', ''],
  [
    'refused states sent again',
    A,
    '        // Sent again at the next wake-up of the timer (same day): never lost.\n        this.levelsDay = undefined;',
    '',
  ],
  // /data.
  ['never written while being read', A, "if (this.data === 'pending') return false;", ''],
  ['one write at a time', A, 'if (this.writing) {', 'if (false) {'],
  // Parsing and bounds.
  [
    'a level is 1 to 4, never 0',
    B,
    'return n >= LEVEL.min && n <= LEVEL.max ? n : null;',
    'return n >= 0 && n <= 9 ? n : null;',
  ],
  ['a line from the future is unreadable', B, '|| at > notAfter) {', ') {'],
  [
    'an unknown J+1 is never replaced by an older J+2',
    B,
    'if (dayBefore) {',
    'if (dayBefore && dayBefore.j1 !== null) {',
  ],
  ['answer bounded', 'src/http.js', 'if (size > maxBytes) {', 'if (false) {'],
  ['no redirect', 'src/http.js', "redirect: 'error',", "redirect: 'follow',"],
  ['gunzip bounded', 'src/source.js', '{ maxOutputLength: maxBytes }', '{}'],
  // Trigger.
  [
    'never at the first read',
    TR,
    'if (!memory) return { events: [], memory: next };',
    'memory ??= { seenAt: 0, issued: "1970-01-01", j1: 1 };',
  ],
  ['never for an old bulletin', TR, 'now - newest.at > EVENT_MAX_AGE ||', ''],
  ['a correction compared with the one seen', TR, 'memory.issued === newest.issued', 'false'],
  // Review r1.
  [
    'r1 I1 backoff doubled on any failure',
    A,
    'const doubled = PAUSE.min * 2 ** Math.min(count - 1, 8);',
    'const doubled = PAUSE.min;',
  ],
  [
    'r1 I1 backoff ended only by a usable answer',
    A,
    '    // A usable answer ends the backoff (never before the file is read).\n    this.pause = undefined;\n',
    '',
  ],
  [
    'r1 M1 memory written before the events',
    A,
    'if (memoriesChanged) await this.saveState();',
    'if (memoriesChanged) void 0;',
  ],
  [
    'r1 M2 a deleted device forgets its memory',
    A,
    'let changed = this.memories.delete(id);',
    'let changed = false;',
  ],
  [
    'r1 M3 memory seeded for a device created after the read',
    A,
    'this.memories.set(target.deviceId, memory);\n        memoriesChanged = true;\n      }\n      if (events) {',
    'memoriesChanged = true;\n      }\n      if (events) {',
  ],
  ['r1 M5 the later line of the same second wins', B, 'before.at <= at', 'before.at < at'],
];

async function run(dir) {
  // `node --test test/*.test.js`, the glob expanded here.
  const files = (await readdir(join(dir, 'test'))).filter((f) => f.endsWith('.test.js')).sort();
  return new Promise((resolve) => {
    const args = ['--test', '--test-timeout=60000', ...files.map((f) => `test/${f}`)];
    const child = spawn(process.execPath, args, {
      cwd: dir,
      stdio: 'ignore',
      detached: true,
      shell: false,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      resolve('timeout');
    }, DEADLINE);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? 'survived' : 'killed');
    });
  });
}

/** A copy of the repository (no `.git`; `node_modules` copied, never linked). */
async function copy(dir) {
  await cp(REPO, dir, {
    recursive: true,
    filter: (src) => !/[/\\]\.git$/.test(src),
  });
}

async function main() {
  const filter = process.argv[2];
  const survivors = [];
  // The unmodified suite first: a red baseline would make every mutant look killed.
  const base = await mkdtemp(join(tmpdir(), 'mdf-baseline-'));
  try {
    await copy(base);
    const outcome = await run(base);
    if (outcome !== 'survived') {
      console.log(`baseline FAILED (${outcome})`);
      process.exitCode = 1;
      return;
    }
    console.log('baseline ok');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
  for (const [name, file, from, to] of MUTANTS) {
    if (filter && !name.includes(filter)) continue;
    const dir = await mkdtemp(join(tmpdir(), 'mdf-mutant-'));
    try {
      await copy(dir);
      const path = join(dir, file);
      const text = await readFile(path, 'utf8');
      const count = text.split(from).length - 1;
      if (count !== 1) {
        console.log(`STALE   ${name}: found ${count} times in ${file}`);
        survivors.push(name);
        continue;
      }
      await writeFile(path, text.replace(from, to));
      const outcome = await run(dir);
      console.log(`${outcome.toUpperCase().padEnd(8)}${name}`);
      if (outcome !== 'killed') survivors.push(name);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  console.log(survivors.length ? `Not killed: ${survivors.join(', ')}` : 'Every mutant killed');
  process.exitCode = survivors.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
