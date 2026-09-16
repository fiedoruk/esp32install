# esp32install

A browser page that writes firmware to an ESP32 over a USB cable. It is a set of
static files: no build step, no bundler, no CDN, nothing to install on a server
beyond copying a directory. Anyone can put their own firmware behind it by
writing one JSON manifest and listing it in `catalog.json`.

Live demo: <https://esp32ai.me/install>

## What you need

The page talks to the device through the Web Serial API, which today means
**Chrome or Edge on a desktop computer** (Windows, macOS, Linux), and the page
must be served over **HTTPS** or opened from `localhost`.

Anywhere else the page still loads, still shows the release, the files and their
checksums, and still prints a ready-made `esptool` command line under *Other ways
to install*. Only the button is replaced by a sentence:

- Not a secure address: *"This page has to be opened over a secure (https)
  address before it can talk to a device."*
- No Web Serial (Firefox, Safari, any phone): *"This browser cannot talk to a
  device over a cable. Use Chrome or Edge on a computer. A phone will not do."*

## Replicate in three steps

**1. Copy the site.** Put the contents of this repository on any static host that
serves HTTPS. There is nothing to compile.

```
rsync -a --exclude '.git' --exclude 'tests' --exclude '__pycache__' ./ /var/www/install/
```

The whole site is about 860 KB, most of it the vendored esptool-js bundle and the
fonts. `tests/` and `tools/` are not needed on the server; leaving `tools/` there
is harmless and handy, because `check.py` then runs from the same machine.

**2. Write a manifest for your firmware.** Put the binaries next to the manifest
and let the tool measure sizes and checksums. Give the output a name of your own;
the shipped `firmware/demo-1-0-0.json` is the schema 1 example and is best left
as it is:

```
python3 tools/manifest.py firmware/demo.bin@0x1000 \
  --chip ESP32 --name "Demo firmware" --version 1.0.0 \
  --prompt-erase --out firmware/my-firmware-1-0-0.json
```

```
wrote firmware/my-firmware-1-0-0.json: Demo firmware 1.0.0, 1 part, 4096 bytes
```

`--help` lists every option, including `--profile preserve` and the compatibility
regions that profile needs. See [docs/manifest.md](docs/manifest.md).

**3. List the release and check the result.** Add the release to `catalog.json`,
then ask the tool whether the site really serves everything the page will fetch:

```
python3 tools/check.py https://example.com/install/
```

```
OK csp index.html pins default-src to 'self'
OK vendor esptool-js-0.6.1.js matches the pinned checksum
OK catalog catalog.json lists 1 system
OK size build-1: demo.bin is 4096 bytes
OK sha256 build-1: demo.bin
OK layout build-1: 1 part, no overlap
OK chip build-1: demo.bin is an ESP32 image
SUMMARY 7 OK, 0 WARN, 0 FAIL
```

It exits 0 when nothing failed, 1 on any FAIL, 2 when the command was wrong. It
takes a directory as well as a URL, so you can run it before you upload.

Full walkthrough for Apache, nginx, GitHub Pages and other hosts:
[docs/replicate.md](docs/replicate.md).

## What is checked before anything is written

Every one of these is a hard stop. The device is not touched until all of them
have passed.

- **Where the files may come from.** Every part URL must resolve to the origin
  that served the manifest, or to an origin the site listed in `allowOrigins`.
  Only `http:` and `https:` are accepted, and any user name or password in the
  URL is stripped. An origin in `allowOrigins` also has to be added to
  `connect-src` in the page's Content-Security-Policy, or the browser blocks the
  fetch; `check.py` accepts exactly the listed origins there.
- **Where the bytes actually came from.** Redirects are followed, but the final
  response has to be on the same origin as the request; otherwise the download is
  rejected.
- **Size.** A part that declares `size` must arrive with exactly that many bytes.
  An empty part is refused, a single part above 32 MiB is refused, and all parts
  together above 64 MiB are refused.
- **Checksum.** A part that declares `sha256` must hash to it. A part that
  declares none is hashed anyway and the hash is written to the log, so a reader
  can compare it with the release notes.
- **Layout.** No part may reach past the end of the flash the chip reported, and
  no two parts may overlap.
- **Flash size.** Read from the JEDEC id the chip returns. An id of `0x000000` or
  `0xffffff`, or a size code the library does not know, stops the install. There
  is no silent fallback to 4 MB.
- **The right chip.** The part that covers the chip's bootloader offset must
  start with the ESP image magic `0xE9`, and the chip id inside that header must
  be the one this chip family declares. Every other part that starts with `0xE9`
  is held to the same chip id, so an application built for another chip is
  refused even when nothing is written at the bootloader offset.
- **The right build.** A build is offered only if its chip family, and any
  `flashSizeMB`, USB vendor and product id, chip-description substrings and
  feature strings it declares, match the hardware that is plugged in.
  `flashSizeMB` is an equality filter, not a minimum. USB ids are compared only
  when both the build and the port report them.

The `preserve` profile adds more before it writes: the chip must not have secure
boot or flash encryption enabled, its MAC address is read and re-read so the
device cannot be swapped mid-install, the existing flash header must match the
regions the manifest declares, and a whole-flash backup must be read twice, agree
byte for byte, be saved, and then be picked from disk by the user.

## What is checked after writing

- esptool-js hashes each file before compression, reads the MD5 back from the
  chip after writing it, and throws when the two differ. That applies to both
  profiles.
- The `preserve` profile reads the MD5 back a second time itself, per part, and
  compares it with its own hash of the same bytes.
- The `preserve` profile then re-reads the flash header span and proves two
  things: bytes outside every written part are unchanged, and bytes inside a
  4 KiB sector a write touched but outside the part itself read back as `0xff`.
- A hard reset is attempted last. If it fails, the log says to press reset or
  replug, because the image is already written and verified at that point.

## Supported chips

Taken from the table in `app/verify.js`, measured against esptool-js 0.6.1.

| Chip family | esptool `--chip` | Bootloader offset | Image chip id |
|---|---|---|---|
| ESP8266 | `esp8266` | `0x0` | none — magic byte only |
| ESP32 | `esp32` | `0x1000` | 0 |
| ESP32-S2 | `esp32s2` | `0x1000` | 2 |
| ESP32-S3 | `esp32s3` | `0x0` | 9 |
| ESP32-C2 | `esp32c2` | `0x0` | 12 |
| ESP32-C3 | `esp32c3` | `0x0` | 5 |
| ESP32-C5 | `esp32c5` | `0x2000` | 23 |
| ESP32-C6 | `esp32c6` | `0x0` | 13 |
| ESP32-C61 | `esp32c61` | not declared by the library | 20 — not checked |
| ESP32-H2 | `esp32h2` | `0x0` | 16 |
| ESP32-P4 | `esp32p4` | `0x2000` | 18 |

Two caveats worth knowing before you publish:

- **ESP8266** images carry no chip id field, so only the `0xE9` magic byte is
  checked. An image built for a different ESP8266 board will pass that check.
- **ESP32-C61** is the one chip esptool-js 0.6.1 does not give a bootloader
  offset for. The check at the bootloader offset is skipped for it; parts that
  start with `0xE9` are still checked for the C61 image id. Everything else still
  applies.

## The two profiles

**`factory`** is the default and behaves like a classic flasher. It downloads and
verifies every part, optionally offers to erase the whole chip first, then writes
all parts in one call. Saved Wi-Fi credentials and settings survive only if the
erase is declined and the release does not overwrite the area that holds them. A
whole-flash backup is offered as an optional keepsake; it is never a gate.

**`preserve`** exists for a device that already has a factory bootloader,
partition table and user data that must stay. It never erases. It writes only the
parts the manifest lists, one at a time, and it refuses to start unless the flash
already looks the way the manifest says it should. The backup is mandatory there,
and the user has to hand the saved file back to the page before the first write.

Step by step, with every stop condition: [docs/profiles.md](docs/profiles.md).

## Third-party code in the bundle

`vendor/esptool-js/esptool-js-0.6.1.js` is esptool-js 0.6.1, Apache-2.0, vendored
rather than fetched from a CDN. Its checksum is pinned in
`vendor/esptool-js/SHA256SUMS` and `tools/check.py` verifies it on every run:

```
ef7d5a237d3f273ecf546bcee65dddad90bd82cf02f22a980d1537e0cd79a152  esptool-js-0.6.1.js
```

The bundle embeds pako 2.1.0 (MIT AND Zlib) for deflate.

Three font families are vendored under `assets/fonts/`, all under the SIL Open
Font License 1.1, with the licence text next to each family: Figtree, Source
Sans 3 and Recursive Mono Casual. Their checksums are in
`assets/fonts/SHA256SUMS`.

Full attributions: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Running the tests

```
node --test
python3 -m unittest discover -s tools/tests -t .
```

The first runs the browser-side suite against a fake esptool, so no hardware is
needed. The second runs the Python tools' suite. Both are expected to pass with
no failures.

## Security

The threat model, what the installer can and cannot verify, and the reasoning
behind the Content-Security-Policy are in [docs/security.md](docs/security.md).
To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Contributing

Open an issue describing the device or the release format before writing code, so
the manifest schema stays one schema.

Every change needs both test suites green, and a change to `app/` or `tools/`
needs a test that fails without it.

Keep the product free of local paths, private addresses and anything specific to
one publisher's site; the demo site is an example, not a dependency.

## Licence

MIT. See [LICENSE](LICENSE).

Not affiliated with, endorsed by, or supported by Espressif Systems. "ESP32" and
"ESP8266" are used only to name the hardware this tool writes to.
