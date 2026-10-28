# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- An accepted drop is now the floor: a reading lower still is held (never
  counted without a new click), and the real value that follows is taken
  instead of being held as a jump.

## [0.1.3] - 2026-10-27

### Changed

- Integration SDK 0.16 (no change for the devices).

## [0.1.2] - 2026-10-25

### Fixed

- Reads never started with a real clock on a fresh install

## [0.1.1] - 2026-10-22

### Added

- Hypontech micro-inverters, plants and batteries through the Hypon cloud
  (`api.hypon.cloud`), read-only, every 5 minutes by default (2 to 60):
  per plant the solar power, the energy of the day, the grid and home power
  and the battery when the cloud gives them; each inverter (power, energy of
  the day, online, fault, warning) and each battery (charge, cycles) as its
  own device.
- A solar production index for the Gladys energy monitoring: the lifetime
  total of the cloud, checked by the index guard of gladys-p1-monitor (never
  0, a jump or a drop held back, never confirmed by time; a jump taken in two
  clicks of "Accept the held index", bounded to the values listed; a drop
  never accepted, it corrects itself). One margin per index, learned from the
  power the cloud gives; the night never widens the margin of the morning; a
  plant total is counted only when it reaches the sum of its inverters. It is
  carried by each inverter (default), by the plants, or by none: never by
  both levels, and the index of a level left stops for good (never counted
  twice).
- The login refused by the cloud stops everything until other credentials
  are saved or the test button logs in; 429 and 5xx pause the reads (1 min
  to 6 h, kept in /data); never two reads less than an interval apart, even
  after a restart.

[Unreleased]: https://github.com/LM1LC3N7/gladys-hypontech/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/LM1LC3N7/gladys-hypontech/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/LM1LC3N7/gladys-hypontech/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-hypontech/releases/tag/v0.1.1
