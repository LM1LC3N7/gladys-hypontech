# TODO

## Before announcing

- [ ] Test on a real Gladys 5.2+ with a real Hypon cloud account (micro-
      inverters, ideally a plant with a battery): test button, device
      creation, the night, the production the core derives from the index.
- [ ] Test the Docker image (no Docker on the development PC yet).
- [ ] Run the store validator (`npx github:GladysAssistant/integration-store .`):
      the development agent could not run it.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).

## To confirm on a real account (built without one)

- [ ] What the login answers for a wrong password: 401 (as the library
      expects), or 200 with an error envelope (then no token: refused, final,
      as the library treats it).
- [ ] `e_total` of a plant and of an inverter: kWh, never reset, never lower
      when an inverter is offline (a plant total that drops at night would
      be held every evening; the status would show it).
- [ ] The sign of `meter_power` (import > 0?) and of `w_cha` (charge or
      discharge > 0?): the library's model and its API.md disagree.
- [ ] The format of `time` (plant): with its offset (as the library's test
      data), else the "stale plant" check never applies.
- [ ] The status texts of an inverter (`online` / `offline` / others).
- [ ] Whether the monitor of a micro-inverter plant answers (and with 0s).
- [ ] Does `plant/<id>/battery` answer 404 or an empty list without battery.
- [ ] Rate limits of the cloud (429 seen by users of the library at 60 s).

## Later

- [ ] Per-plant peak power (one value for all plants today).
- [ ] The embedded battery snapshot of an inverter answer (unused).
- [ ] Revenue (`today_earning`) as daily-production-revenue, if wanted.

## Decisions

- Version 0.1.0 set by hand in package.json, package-lock.json, the manifest
  and the `docker_image` tag (the first release patch gives 0.1.1).
- The cloud gives a cumulative lifetime total (`e_total`): the index is that
  total through the approved guard of gladys-p1-monitor (src/guard.js, as in
  gladys-zeversolar and gladys-imeon: `maxKw` as a parameter). Nothing is built
  from a counter of the day, so the daily-index mechanism of gladys-imeon
  0.1.2 / gladys-zeversolar 0.1.4 is not needed. A drop of this total can be
  accepted (a replaced inverter, as a P1 meter): the core then counts nothing
  for it.
- Margin of the guard: 1.25 x the peak power typed (bounded 2 to 1250 kW),
  else 60 kW; slack 0.5 kWh.
- Acceptance in two clicks (several indexes may be held at once): the first
  lists, the second (within 5 min) takes exactly the values listed; a value
  changed since stays held.
- Double counting: the index is on ONE level, chosen in the form (`plant`
  default, `inverters`, `none`). A created device keeps an index feature it
  had (never a lost feature) but receives no value when the level changes.
- Units and categories of the core only: energy-production-sensor (W, kWh),
  grid-sensor/power (signed W), energy-sensor/power (home load, as the core
  says for a "load power"), battery-storage/battery-level (%), unknown
  without unit for the battery power (its sign is unknown) and the flags.
- Identity: `plant:<plant_id>`, `inverter:<sn>`, `battery:<sn>`; an item
  without a usable id gets no device (counted in the status).
- Refused credentials (401/403 at login, or no token in its answer) are
  final, kept in /data as an HMAC with a random salt, erased at the first
  successful login; the test button tries once more, never sooner than the
  interval. A 401 on a GET is not a refusal: one login and one new try in the
  read, then an error of the read (retries doubled from the interval).
- The library's retries (3 x 10 s) are not ported: one try per read.
- 429 or 5xx on the login or the plant list: pause 1 min to 6 h (Retry-After
  honoured within it), in /data. A 429 on a secondary page stops the read
  after publishing what was read, then pauses; a 5xx there only skips it.
- No User-Agent of ours, no app key: Node's own fetch, as the library.
- Budget: 280 states a minute, indexes first, the rest at the next read.
