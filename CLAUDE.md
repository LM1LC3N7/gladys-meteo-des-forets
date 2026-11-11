# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It reads the yearly open-data file of the Météo des forêts (Météo-France,
data.gouv.fr, Licence Ouverte 2.0) and publishes the forest fire danger of
today and tomorrow for the departments the user follows. Read only.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/pure.test.js             # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
node scripts/mutants.mjs [filter]         # the mutants the tests must kill (wrap in memcap)
npx github:GladysAssistant/integration-store .   # store admission checks
```

## Architecture

```
index.js              SDK wiring only: handlers registered before connect()
src/app.js            ForestApp: schedule (slots of the source, MIN_GAP, pauses), read, publish, status
src/bulletin.js       the CSV (every year's format) -> bulletins; Paris days; level of a day (pure)
src/source.js         one conditional GET (ETag) + bounded gunzip
src/http.js           bounded GET (timeout, size, User-Agent, no redirect), SourceError
src/devices.js        device per department, external ids dep:<code> (forever)
src/triggers.js       the scene trigger fire_danger_forecast (pure)
src/departments.js    the 96 departments of the Météo des forêts
src/i18n.js           runtime texts (en/fr), times in Paris time
src/store.js          /data JSON file (temporary file + rename, one write at a time)
test/                 node --test against the SDK's fake Gladys, a fake S3, virtual and real clocks
scripts/mutants.mjs   the versioned list of mutants
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
