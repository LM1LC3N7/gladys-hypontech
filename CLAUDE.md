# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads a **Hypon cloud account** (Hypontech micro-inverters, plants,
batteries) through the undocumented API `https://api.hypon.cloud/v2`, as
[hyponcloud](https://github.com/jcisio/hyponcloud) (jcisio, MIT, see
`THIRD_PARTY_NOTICES.md`) reads it. Unofficial: not affiliated with Hypontech.
**Read-only**: never `onSetValue`; the login (POST) and GETs only. Siblings:
`gladys-p1-monitor` (the index guard, approved), `gladys-zeversolar` (the
structure: pace kept in /data, pauses, generations, the production index and
its 30-minute production), `gladys-webuntis` (refused credentials, final and
fingerprinted), `gladys-apsystems` (features of a created device never lost).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png, 800 x 534, plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

On the development PC, set `npm_config_cache` and `npm_config_logs_dir` to
`C:\Users\user\devtools\npm-cache` first (never under AppData). The CI runs
`format:check`, `lint` and `test` on Node 22 and 24.

## Architecture

```
index.js                SDK wiring only: handlers registered before connect()
src/app.js              HyponApp: pace, reads, devices, index guards, pauses, refusal, buttons
src/hypon/client.js     the only network access (login + GETs, bounded, token in memory)
src/hypon/model.js      the answers -> our values (pure, field by field)
src/devices.js          the Gladys devices and their states (pure)
src/guard.js            plausibility of an energy index (gladys-p1-monitor, unchanged but maxKw)
src/config.js           the form, normalized
src/store.js            /data: salt, pace, pause, refused fingerprint, guards
src/i18n.js             every runtime text, { en, fr }
src/constants.js        keys and limits (keys are forever)
```

## Rules (do not break)

- External ids are forever: `plant:<plant_id>`, `inverter:<sn>`,
  `battery:<sn>`; feature keys in `src/devices.js`. An item without a usable
  id gets no device (counted in the status), never a guessed id.
- The production index is the cloud's lifetime total (`e_total`), through
  `IndexGuard` (never 0, jumps and drops held, never confirmed by time,
  accepted only by two clicks, bounded to the values listed). One level only
  (`index_source`): plants, inverters or none, never two. Never a counter of
  the day as an index, never `publishEnergyConsumption`, never a fallback to
  another source after a value.
- Never two reads less than an interval apart (the attempt is written in
  /data BEFORE the read); a 429/5xx pauses (1 min to 6 h, in /data); refused
  credentials are final (salted fingerprint in /data, erased at the first
  successful login); at most one login per read; never a retry loop.
- A late answer of a former account publishes nothing and sets no status
  (`gone()` after every await).
- Never log or keep the password, the username, the token, nor a text of the
  cloud. The password field is "kept by Gladys in its database, never shown
  again"; never say it is protected otherwise (a test checks the words).
- Core units only (`DEVICE_FEATURE_UNITS_BY_CATEGORY`); a device republished
  keeps every feature of its created device (`keepCreatedFeatures`).
- At most 280 states a minute, indexes first.
- Files in UTF-8 without BOM (`test/encoding.test.js`).

## Releases

Version 0.1.0 was set by hand (package.json, package-lock.json, manifest,
docker_image); the Release workflow bumps them together and rolls
`CHANGELOG.md`. Describe every change under `## [Unreleased]`.
