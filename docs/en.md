# Hypontech (Hypon cloud)

**Unofficial** connector, not affiliated with Hypontech. It reads your Hypon
cloud account (the one of the Hypontech app and of hypon.cloud), **read-only**,
and gives Gladys your Hypontech micro-inverters, plants and batteries. It never
sends a command.

**Never tested with a real device** nor with a real account: the Hypon cloud
API is not documented; it is read as the
[hyponcloud](https://github.com/jcisio/hyponcloud) library (the one of the Home
Assistant integration) reads it. Feedback is welcome on the GitHub repository.

## What you get

For each **plant** of your account:

- the solar power (W) and the energy of the day (kWh);
- a **solar production index** for the Gladys energy monitoring (see below);
- the power exchanged with the grid, the home consumption, the battery charge
  and power, when the cloud gives them for this plant.

For each **inverter**: power, energy of the day, online, fault, warning. At
night an offline micro-inverter goes to 0 W; its counters keep their last
value.

For each **battery**: charge (%) and number of cycles.

## Configuration

1. Install the integration from the Gladys store.
2. Enter the **username** and the **password** of your Hypon account (the ones
   of the Hypontech app). The password is kept by Gladys in its database,
   never shown again, and sent only to the Hypon cloud (`api.hypon.cloud`). It
   is never logged, nor the username, nor the session token.
3. **Portal**: Hypontech for almost everyone; EAS Solar or Nexen if your
   installer gave you their portal.
4. **Production index**: on the plants (default), on each inverter, or none.
   Never both: the production would be counted twice. Choose "None" if another
   meter (a production meter, a smart plug, another integration) already
   counts this production in Gladys.
5. **Peak power** (optional): the one of your largest plant, on the installer's
   invoice. It bounds what the index may take between two reads. Empty: 60 kW.
   Never enter less than the real value.
6. **Read every**: 5 minutes by default (2 to 60). Each read makes about four
   requests per plant; the cloud itself is only updated every few minutes.
7. Open the **Discover** tab and create the devices you want. Their values come
   at the next read.

## The production index

The cloud gives, for each plant and each inverter, the energy produced since
it was put into service. Gladys counts every rise of this index as production.
So that an odd value is never counted:

- an index of 0 is never sent;
- a plausible rise (no more than the peak power × the time elapsed) goes through;
- a **jump** or a **drop** is **held back**: the last accepted value is sent
  again, the status of the integration shows it, and it stays held across a
  restart. Neither time nor repetition confirms it;
- to take it, click **"Accept the held index"**: the first click lists the
  values held and accepts nothing; a second click within 5 minutes accepts
  exactly these values, counted at once at the next read. A value that changed
  meanwhile stays held. Saving the configuration never accepts anything.

To change the level of the index later: save the configuration, then "Update"
the devices in the Discover tab. A device keeps the index it had (its history
is never deleted), without new values.

## Pace, pauses and refusals

- Never two reads less than an interval apart, even after a restart, a
  reconnection, a save of the configuration or a click on "Test the
  connection" (the time of the last read is kept in `/data`).
- One login (token) per hour of reads; never a login loop.
- If the cloud asks to wait (429, or a 5xx error), the reads pause from 1
  minute to 6 hours, kept across a restart.
- If the cloud **refuses the username or the password**, nothing more is sent
  with them, even after a restart. Save the right ones, or click "Test the
  connection" for one more try (never sooner than the interval). The refusal is
  erased only by a login that works.
- `/data` never keeps the password, the username nor the token: only the time
  of the last read, a pause, the salted fingerprint of refused credentials
  (erased at the first success) and the state of the indexes.

## Known limits

- The cloud API is not documented: it may change without notice.
- The sign of the grid power and of the battery power is the one the cloud
  gives; it could not be checked.
- A plant the cloud has not updated for more than 2 hours (gateway offline) no
  longer sends its power.
- At most 10 plants and 100 inverters or batteries per plant are read.
- No Bluetooth, no local access to the gateway.
