# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-11

### Added

- First version: the forest fire danger of the Météo des forêts (Météo-France,
  open data on data.gouv.fr, Licence Ouverte 2.0) for up to 10 departments:
  levels of today and tomorrow (1 low to 4 very high), the text of the latest
  bulletin, and the scene trigger "Forest fire danger forecast raised".
- Reads at the times the bulletin comes out (15:30 UTC, again until it is in;
  once a day off season), the ETag of the file (304 without download), at
  least 20 minutes between two requests; after any failure a backoff of
  20 minutes doubled up to 6 hours, kept across a restart.
- Off season and before the file of the year exists: "no bulletin", not an
  error, nothing published as 0.

[Unreleased]: https://github.com/LM1LC3N7/gladys-meteo-des-forets/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-meteo-des-forets/releases/tag/v0.1.1
