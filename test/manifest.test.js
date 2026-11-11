// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. The devices use
// only the units the core accepts for their categories, and the core's rules
// for `supported_options` (a whole Discovery is refused for one bad option).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TYPES,
} from '@gladysassistant/integration-sdk';
import { DEFAULTS } from '../src/config.js';
import { ACTIONS, LEVEL, SCENE_TRIGGERS, USER_AGENT } from '../src/constants.js';
import { FEATURE } from '../src/devices.js';
import { created } from './helpers/app.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics; the same version everywhere (semver, never pinned by hand)', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, '0.1.0');
  assert.equal(manifest.version, pkg.version);
  assert.equal(
    manifest.docker_image,
    `ghcr.io/lm1lc3n7/gladys-meteo-des-forets:${manifest.version}`,
  );
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.name, 'gladys-meteo-des-forets');
  // The User-Agent follows the version the release bumps.
  assert.equal(
    USER_AGENT,
    `gladys-meteo-des-forets/${pkg.version} (+https://github.com/LM1LC3N7/gladys-meteo-des-forets)`,
  );
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^0\.16\./);
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.deepEqual(manifest.categories, ['environment']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.equal(manifest.location, undefined, 'no house position needed');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('the docs say: no real device, information only, off season, the licence of the data', () => {
  for (const file of ['docs/fr.md', 'manifest']) {
    const text = file === 'manifest' ? manifest.config_schema[0].description.fr : read(file);
    assert.match(text, /[Jj]amais\s+testé\s+avec\s+un\s+vrai\s+appareil/, file);
    assert.match(text, /hors saison/i, file);
    assert.match(text, /jamais un système d.alerte/i, file);
    assert.match(text, /Licence Ouverte/, file);
    assert.match(text, /Météo-France/, file);
  }
  for (const file of ['docs/en.md', 'README.md', 'manifest']) {
    const text = file === 'manifest' ? manifest.config_schema[0].description.en : read(file);
    assert.match(text, /[Nn]ever\s+tested\s+with\s+a\s+real\s+device/, file);
    assert.match(text, /off season/i, file);
    assert.match(text, /never an alert system/i, file);
    assert.match(text, /Licence Ouverte/, file);
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
      assert.equal(typeof text[lang], 'string', `${path}.${lang}`);
    }
  }
});

test('the configuration matches the code: keys, defaults, no secret', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), ['intro', 'departments', 'language']);
  for (const key of Object.keys(fields)) {
    assert.doesNotMatch(key, /^gladys_/);
    assert.match(key, /^[a-z0-9_]+$/);
    assert.notEqual(fields[key].type, 'secret');
  }
  assert.equal(fields.departments.type, 'string');
  assert.equal(fields.departments.default, undefined);
  assert.equal(fields.language.default, DEFAULTS.language);
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    ['fr', 'en'],
  );
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
  assert.ok(fields.intro.links.length <= 5);
  for (const lang of ['en', 'fr']) assert.ok(fields.intro.description[lang].length <= 1000, lang);
});

test('the actions and the scene trigger of the manifest are the ones of the code', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(index.includes("on('connected'"));
  assert.ok(!index.includes('onSetValue'), 'read only');
  for (const action of manifest.actions) {
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120, action.key);
  }
  assert.deepEqual(
    manifest.scene_triggers.map((s) => s.key),
    Object.values(SCENE_TRIGGERS),
  );
  const [raised] = manifest.scene_triggers;
  assert.deepEqual(
    raised.fields.find((f) => f.key === 'level').options.map((o) => o.value),
    ['2', '3', '4'],
  );
  assert.equal(LEVEL.max, 4);
  assert.deepEqual(
    raised.variables.map((v) => v.key),
    [
      'current_level',
      'level_name',
      'previous_level',
      'day_after_level',
      'department_code',
      'forecast_date',
      'bulletin_at',
    ],
  );
  for (const trigger of manifest.scene_triggers) {
    assert.equal(trigger.fields[0].key, 'department');
    assert.equal(trigger.fields[0].source, 'devices');
    for (const field of trigger.fields) {
      for (const option of field.options ?? []) assert.equal(typeof option.value, 'string');
    }
  }
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /Licence Ouverte/);
  assert.match(notices, /Météo-France/);
  assert.match(notices, /integration-sdk/);
});

// The core's units by category, when a Gladys clone is at hand (not on GitHub CI).
const CORE_CONSTANTS = '/home/claude/code/Gladys/server/utils/constants.js';
const core = existsSync(CORE_CONSTANTS)
  ? createRequire(import.meta.url)(CORE_CONSTANTS)
  : undefined;
const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

const devices = () => [created('13'), created('2A')];

test('the features: read only, known categories and types, units the core accepts', () => {
  for (const device of devices()) {
    assert.deepEqual(
      device.features.map((f) => f.external_id.split(':').at(-1)),
      Object.values(FEATURE),
    );
    for (const f of device.features) {
      assert.equal(f.read_only, true);
      assert.ok(Object.values(C).includes(f.category), f.category);
      assert.notEqual(f.category, C.SWITCH);
      if (core && f.unit) {
        const byType = core.DEVICE_FEATURE_UNITS_BY_CATEGORY_AND_TYPE?.[f.category]?.[f.type];
        const allowed = byType ?? core.DEVICE_FEATURE_UNITS_BY_CATEGORY[f.category] ?? [];
        assert.ok(allowed.includes(f.unit), `${f.category}/${f.type}: ${f.unit}`);
      }
    }
  }
  assert.equal(TYPES.RISK.INTEGER, 'integer');
});

test('the supported options follow the rules of the core (a bad one refuses all Discovery)', () => {
  const OPTION_KEYS = ['id', 'value', 'label', 'sort_order'];
  let lists = 0;
  for (const device of devices()) {
    for (const f of device.features) {
      if (f.supported_options === undefined) continue;
      lists += 1;
      const allowStringValues = f.category === C.TEXT && f.type === TYPES.TEXT.SELECT;
      assert.ok(Array.isArray(f.supported_options) && f.supported_options.length > 0);
      for (const option of f.supported_options) {
        assert.equal(typeof option.label, 'string');
        assert.ok(option.label.trim().length > 0);
        assert.equal(option.label, option.label.trim());
        assert.ok(
          Number.isInteger(option.value) ||
            (allowStringValues && typeof option.value === 'string' && option.value.length > 0),
        );
        assert.deepEqual(
          Object.keys(option).filter((k) => !OPTION_KEYS.includes(k)),
          [],
        );
      }
      const values = f.supported_options.map((o) => `${o.value}`);
      assert.equal(new Set(values).size, values.length);
      if (normalizeSupportedOptions) {
        assert.doesNotThrow(() =>
          normalizeSupportedOptions(f.supported_options, { allowStringValues }),
        );
      }
    }
  }
  assert.equal(lists, 0, 'no list today: the rules apply to any added later');
});
