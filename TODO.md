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

## Remaining risks (review 1)

- [ ] m1: /data lost (volume recreated) and the container stopped for days:
      the guard is rebuilt from `last_value_changed`, its margin covers the
      stop; an odd value read at the restart could pass (bounded by the
      learned power since I2). Inherent (p1-monitor alike).
- [ ] A plant total is checked against the highest total seen per inverter:
      an inverter total that glitches up once raises that sum for good; the
      plant index then stalls (counted less, never more) with the note
      "below the sum of their inverters". "Each inverter" avoids it. Since
      approval 1 (R2) a listed inverter that never gives a total above 0
      also keeps the plant index waiting (less, never more).
- [ ] Approval 1 (R1): an index at rest is re-dated even without a total (an
      offline inverter shown with 0), never when its source is stale or not
      read.
- [ ] A gateway down by day shown at 0 W by the cloud: the night re-dating
      applies, the catch-up may be held (less, until the click).
- [ ] m7: a 401 on every GET right after a successful login (an account
      without rights) gives one login an hour forever; consider a final
      "session refused" after a few in a row.
- [ ] m4: the grid power sign (import > 0) is what the core type assumes and
      what the library's test data suggest; to confirm.

## Later

- [ ] Per-plant peak power (one value for all plants today).
- [ ] Battery power as battery-storage charge/discharge once its sign is known.
- [ ] The embedded battery snapshot of an inverter answer (unused).
- [ ] Revenue (`today_earning`) as daily-production-revenue, if wanted.

## Decisions

- Version 0.1.0 set by hand in package.json, package-lock.json, the manifest
  and the `docker_image` tag (the first release patch gives 0.1.1).
- The cloud gives a cumulative lifetime total (`e_total`): the index is that
  total through the approved guard of gladys-p1-monitor (src/guard.js, as in
  gladys-zeversolar and gladys-imeon: `maxKw` as a parameter). Nothing is built
  from a counter of the day, so the daily-index mechanism of gladys-imeon
  0.1.2 / gladys-zeversolar 0.1.4 is not needed. Review 1 (B1): a reading
  equal to the reference while the source produces nothing (plant at 0 W,
  inverter offline or at 0 W) dates the reference now (guard.js unchanged,
  the app sets `guard.last`); the plant total reaches the guard only when the
  inverters were read and it is at least the sum of the highest totals seen
  per inverter (0.1 kWh per inverter + 0.05 of rounding), kept in /data.
- A drop of a production total is never accepted (review 1, I1, zeversolar
  I2): it corrects itself when the total comes back. Jumps only, two clicks.
- Margin per index (review 1, I2, as zeversolar 0.1.4): plant 1.25 x the
  typed peak, else 1.5 x its highest plausible power over 30 days (7 days
  known), else 60 kW; inverter: its own learned power, else the typed peak x
  1.25, else 15 kW; widened for one read to 1.5 x the plausible power of
  that read (n1, never for a plant with a typed peak); bounded 0.5 to 1250
  kW; slack 0.5 kWh; aberrant powers (> 30 kW for an inverter) ignored, a
  power above 1.5 x the learned top counted only when seen twice.
- Acceptance in two clicks (several indexes may be held at once): the first
  lists the jumps, the second (within 5 min) takes exactly the values listed;
  a value changed since stays held.
- Double counting: the index is on ONE level, chosen in the form
  (`inverters` default since review 1, `plant`, `none`). When the level
  changes, every index feature of the former level is retired for good in
  /data (review 1, B2): never fed again, even if the level comes back; the
  status says so; a device deleted and created again starts afresh. A
  created device keeps the feature (never a lost feature).
- /data keeps the state of every index of a created device, every held
  value and every retired index: no cap that drops one (review 1, I5).
- Any 4xx at login but 408 and 429 is a final refusal (review 1, I4).
- The test button schedules the next read when its read ends, whatever the
  answer of the button (review 1, I3).
- A failed inverters page keeps the inverters known (status, Discovery), sends
  nothing of them and no plant total (m2); a stale plant sends no live value,
  no energy of the day, nothing of its inverters and batteries (m3); grid and
  home power features only after a value other than 0 (m5); a note when no
  created device of the chosen level carries the index (m6).
- Units and categories of the core only: energy-production-sensor (W, kWh),
  grid-sensor/power (signed W), energy-sensor/power (home load, as the core
  says for a "load power"), battery-storage/battery-level (%), unknown
  without unit for the battery power (its sign is unknown) and the flags.
- Identity: `plant:<plant_id>`, `inverter:<sn>`, `battery:<sn>`; an item
  without a usable id gets no device (counted in the status).
- Refused credentials (4xx at login, or no token in its answer) are
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
