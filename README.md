# gladys-hypontech

Unofficial [Gladys Assistant](https://gladysassistant.com) external integration
for **Hypontech** solar micro-inverters, plants and batteries, through the
Hypon cloud (`api.hypon.cloud`), read-only: solar power, energy of the day, a
guarded solar production index for the energy monitoring, grid and home power,
battery charge, and each inverter and battery as its own device. Not
affiliated with Hypontech.

**Never tested with a real device** nor a real account: the cloud API is not
documented and is read as [hyponcloud](https://github.com/jcisio/hyponcloud)
(MIT, jcisio) reads it, see `THIRD_PARTY_NOTICES.md`.

- User guide: [docs/en.md](docs/en.md), [docs/fr.md](docs/fr.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)
- Contributing and architecture: [CLAUDE.md](CLAUDE.md)
- Security: [SECURITY.md](SECURITY.md)

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
npm run cover    # cover.png, 800 x 534, plain Node
```

## License

Apache-2.0 (see `LICENSE`). Logic ported from hyponcloud (MIT): see
`THIRD_PARTY_NOTICES.md`.
