# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Hypontech micro-inverters, plants and batteries through the Hypon cloud
  (`api.hypon.cloud`), read-only, every 5 minutes by default (2 to 60):
  per plant the solar power, the energy of the day, the grid and home power
  and the battery when the cloud gives them; each inverter (power, energy of
  the day, online, fault, warning) and each battery (charge, cycles) as its
  own device.
- A solar production index for the Gladys energy monitoring: the lifetime
  total of the cloud, checked by the index guard of gladys-p1-monitor (never
  0, a jump or a drop held back, never confirmed by time, taken in two clicks
  of "Accept the held index", bounded to the values listed). It is carried by
  the plants (default), by each inverter, or by none: never by both levels.
- The login refused by the cloud stops everything until other credentials
  are saved or the test button logs in; 429 and 5xx pause the reads (1 min
  to 6 h, kept in /data); never two reads less than an interval apart, even
  after a restart.

[Unreleased]: https://github.com/LM1LC3N7/gladys-hypontech/commits/main
