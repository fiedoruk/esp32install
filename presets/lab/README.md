# esp32ai.me lab preset

The configuration behind <https://esp32ai.me/install> — three systems on two different boards,
two install profiles, a stable release and a release candidate side by side. It is here as the
worked example of a multi-device catalogue: read it, copy it, replace the names with yours.

| | |
|---|---|
| `catalog.json` | three systems; emini Home carries two releases so the page offers a rollback |
| `site.json` | the footer of that site |
| `manifests/` | one manifest per release, paths relative to this directory |

## What each entry demonstrates

**emini Home** — the `preserve` profile: the installer writes the partition table and the
application, never the bootloader, and takes a verified copy of all 16 MB before the first byte.
Two releases in one system is what gives a visitor a way back.

**Open Radio** — the `factory` profile with a single merged image written at `0x0`. The simplest
possible entry, and the one most projects need.

**RADBOX** — `channel: "rc"`. A release candidate never wins the highlighted row and never becomes
what a bare `?fw=` link opens; the visitor has to ask for it with `&channel=pre`.

## Why this preset has no downloadable bundle

The ZECTRIX preset ships as a ZIP with its firmware inside, because that firmware is ours under MIT.
Two of the three systems here — Open Radio and RADBOX — are GPL-3.0, and handing out a GPL binary
obliges the distributor to hand out the matching source through that same channel. That offer already
exists for the site that serves them, and extending it to a second channel is a decision we have not
taken, so we do not quietly make it by zipping the binaries.

Nothing stops you using this catalogue with your own images: the shape is the point, not the bytes.

## Using it

Copy `catalog.json`, `site.json` and `manifests/` into the root of your copy of the installer, put
your firmware where the manifests say, and serve the directory over HTTPS. `tools/check.py <dir>`
tells you whether every file the page will ask for is actually there.
