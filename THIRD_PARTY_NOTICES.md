# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
ports no third-party code: it was written from the public file of the Météo des
forêts and its presentation document. It reads the data and runs with the
library below, each under its own licence.

## Météo des forêts (Météo-France)

Météo-France, Météo des forêts, dataset "Archives de la Météo des forêts" on
data.gouv.fr (<https://www.data.gouv.fr/datasets/archives-de-la-meteo-des-forets>):
the yearly files `mdf_<year>.csv.gz`. Licence Ouverte 2.0 / Open Licence 2.0
(Etalab), <https://www.etalab.gouv.fr/licence-ouverte-open-licence/>.

Source: Météo-France, Météo des forêts (data.gouv.fr), Licence Ouverte 2.0.

The integration neither copies nor redistributes the data: it reads it for the
user's own Gladys. The test fixtures in `test/fixtures/` are extracts of the
files of 2024, 2025 and 2026 (the lines of a few departments), kept under the
same licence and attribution. The names of the departments in
`src/departments.js` are those of the 2026 file.

## @gladysassistant/integration-sdk

<https://github.com/GladysAssistant/integration-sdk-js>, the SDK of the Gladys
external integrations (runtime dependency). Apache License 2.0.

## gladys-testkit (tests only)

`test/kit/clock.mjs` is copied from `gladys-testkit` (same author, Apache
License 2.0): the virtual and real clocks of the tests. Not in the image.
