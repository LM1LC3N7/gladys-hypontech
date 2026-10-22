# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the projects below, distributed under their own
licenses.

## hyponcloud (jcisio/hyponcloud)

<https://github.com/jcisio/hyponcloud>, by jcisio, the Python library of the
Hypontech Cloud API (version 1.0.2 on PyPI, branch `main` at commit 1e1bf56,
2026-09-08). MIT License.

Ported to JavaScript in `src/hypon/client.js` and `src/hypon/model.js`: the
address of the API (`https://api.hypon.cloud/v2`), the login
(`POST /login` with the username, the password and the OEM id, the token in
`data.token`, valid one hour, sent as `authorization: Bearer`), the endpoints
and their parameters (`plant/list2?page=&page_size=10&refresh=true`,
`plant/<id>/inverter?page=`, `plant/<id>/battery?page=&page_size=10`,
`plant/<id>/monitor?refresh=true`), the paging (`data` and `totalPage`), the
names and meaning of the fields read (`plant_id`, `plant_name`, `power`,
`e_today`, `e_total`, `status`, `time`, `sn`, `model`, `nick_name`,
`software_version`, `fault`, `warning`, `soc`, `ncyc`, `meter_power`,
`power_load`, `w_cha`), the known OEM portals (`oems.csv`: 0 Hypontech,
3 EAS Solar, 4 Nexen), the 10 s timeout and the treatment of a 401 at login
or of an answer without token as refused credentials. Changed here: one try
per read (no retry loop), at most one login per read, the token never
logged nor kept on disk, every field checked on its own, the answers bounded
in size and time, no redirect followed, and nothing but the login and these
GETs (the administrator information of the account is never read).

Its license notice, reproduced as it appears in its `LICENSE` file:

```
MIT License

Copyright (c) 2025 jcisio

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Hypontech Cloud for Home Assistant (jcisio/hypontech-homeassistant)

<https://github.com/jcisio/hypontech-homeassistant>, by jcisio, the Home
Assistant integration built on the library above (branch `main` at commit
8495e20). Apache License 2.0, the same license as this integration (its full
text is the `LICENSE` file of this repository; its `LICENSE` file names no
copyright holder).

Used as a reference for the choice of the values (per plant: the power, the
lifetime energy as an ever-increasing total, the energy of the day; the
account's username and password as the only settings). No code is copied.
