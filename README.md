# gladys-meteo-des-forets

Unofficial [Gladys Assistant](https://gladysassistant.com) integration: the forest fire danger of
the **Météo des forêts** (Météo-France) by department, for today and tomorrow, with the latest
bulletin and a scene trigger when the forecast rises. Reads the open data on data.gouv.fr (no
account, no key). Mainland France and Corsica.

Information only, never an alert system. Off season (usually October to May) there is no bulletin:
the status says so, it is not an error. Never tested with a real device (a public service), tried
against the real file.

- User guide: [français](docs/fr.md) · [English](docs/en.md)
- Data: Météo-France, Météo des forêts, on data.gouv.fr, under the Licence Ouverte 2.0.

## Development

```bash
npm install
npm test               # node --test (fake Gladys, fake S3, virtual and real clocks)
npm run lint
npm run format:check
node scripts/mutants.mjs   # the mutants the tests must kill (slow)
```

See [CLAUDE.md](CLAUDE.md) for the rules of the project. Licensed under the Apache License 2.0
([LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
