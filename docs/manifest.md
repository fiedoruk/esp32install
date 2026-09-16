# The manifest

A manifest is one JSON file that describes one release: what it is called, which
boards it fits, and which files go at which offsets.

esp32install reads two shapes. **Schema 1** is the esp-web-tools manifest, taken
as it is, so an existing release keeps working. **Schema 2** is a superset: the
same fields, plus the ones the extra checks and the `preserve` profile need. A
file without a `schema` key is read as schema 1.

A file chosen from disk needs no manifest at all. The page builds the same
normalized shape in memory (`localManifest` in `app/manifest.js`): profile
`factory`, one build called `local` with the chip family the user confirmed, one
part per file at the address the user confirmed, with `size` and `sha256`
measured from the bytes. Each part carries the bytes instead of a `path`, is
never fetched, and is held to the same checks as a downloaded one. `preserve`
is refused for it, because a local file carries no `compatibility` data to hold
the device to.

## Files from a build tool

PlatformIO and the Arduino IDE do not produce one file. `pio run` leaves three
or four in `.pio/build/<env>/`, and the Arduino IDE's *Export compiled binary*
does the same next to the sketch. They go at fixed addresses, and the page
suggests exactly these when it recognises the files:

| File | Address | How the page recognises it |
|---|---|---|
| `bootloader.bin` | `0x1000` on ESP32 and ESP32-S2; `0x0` on ESP32-S3, C2, C3, C6, H2; `0x2000` on C5 and P4 | an ESP image whose name contains `bootloader` |
| `partitions.bin` | `0x8000` | the partition-table magic `0xAA 0x50` in its first two bytes |
| `boot_app0.bin` | `0xE000` | its name (the classic ESP32 Arduino core ships it; ESP-IDF builds do not need it) |
| `firmware.bin`, `<sketch>.ino.bin` | `0x10000` | any other ESP image |
| a SPIFFS or LittleFS image | wherever your partition table puts it | not recognised; the address is typed by hand |

The table is the same for a manifest: list each file as a part at that offset,
in rising order. `tools/manifest.py` takes them as
`bootloader.bin@0x1000 partitions.bin@0x8000 boot_app0.bin@0xe000 firmware.bin@0x10000`.

The alternative is one file. esptool can glue a build into a single image
padded with `0xff` between the parts:

```
python -m esptool --chip esp32 merge_bin -o merged.bin \
  0x1000 bootloader.bin 0x8000 partitions.bin 0xe000 boot_app0.bin 0x10000 firmware.bin
```

The result starts with `0xff` up to the bootloader offset and carries the
partition table at `0x8000`, which is what the page recognises as a merged
image and writes at `0x0`, on the own-file path and from a manifest alike. One
part is easier to publish and to check; the individual files are what a
developer has to hand. Both work.

## Schema

### Top level

| Field | Schema | Type | Meaning |
|---|---|---|---|
| `schema` | 2 | `1` or `2` | Absent means 1. Any other value is refused. |
| `name` | 1 | string | Shown on the page. Required, must be non-empty. |
| `version` | 1 | string | Shown on the page. A JSON number is accepted and turned into a string. |
| `builds` | 1 | array | At least one entry. Each entry is one board. |
| `new_install_prompt_erase` | 1 | boolean | Offer a full erase before installing. `factory` only. |
| `profile` | 2 | `"factory"` or `"preserve"` | The profile for the whole release. Absent means `factory`. |
| `eraseAll` | 2 | boolean | Default for every build. The whole chip is erased before the write, in *update* mode as well; the page still shows the erase dialog first, and it says that nothing can be kept. Refused by `preserve`. |

### A build

| Field | Schema | Type | Meaning |
|---|---|---|---|
| `chipFamily` | 1 | string | One of the eleven families in the chip table in the [README](../README.md#supported-chips). Required. |
| `parts` | 1 | array | At least one part. |
| `boardKey` | 2 | string | Stable id for this build. Must start with a letter or digit, then letters, digits, `.`, `-`, `_`, up to 80 characters. Must be unique in the file. Absent means `build-1`, `build-2` and so on. |
| `board` | 2 | string | Name shown when several builds fit. Falls back to `name`, then to the board key. |
| `flashSizeMB` | 2 | integer 0–1024 | The build is offered only on a chip with exactly this flash size. It is an equality filter, not a capacity: a 4 MB build is not offered to a 16 MB chip. |
| `usbVendorId`, `usbProductId` | 2 | integer 0–65535 | Filter the browser's port picker, and reject a board whose ids differ. The ids are compared only when both sides know them: a port that reports no ids is accepted. |
| `chipDescriptionIncludes` | 2 | array of strings | Every string must appear in the chip description, case-insensitively. |
| `featuresAll` | 2 | array of strings | Every string must appear in one of the chip's feature strings. |
| `profile` | 2 | as above | May repeat the top-level value, never change it. A build whose profile differs from the manifest's is refused with `manifest.profile`. |
| `eraseAll` | 2 | as above | Per-build override of the top-level value. |
| `improv` | 1 | boolean | The firmware takes Wi-Fi credentials over [Improv Serial](https://www.improv-wifi.com/serial/) once it boots. Same key as esp-web-tools. See below. |
| `compatibility` | 2 | object | Required by `preserve`, ignored by `factory`. See below. |

### A part

| Field | Schema | Type | Meaning |
|---|---|---|---|
| `path` | 1 | string | Resolved against the manifest's own URL. |
| `offset` | 1 | integer ≥ 0 | Where the file goes in flash. `preserve` requires a multiple of 4096: the chip erases whole 4 KiB sectors, so a part that starts mid-sector would blank the user data in front of it. |
| `size` | 2 | integer > 0 | Exact byte count. Required by `preserve`. |
| `sha256` | 2 | 64 hex characters | Accepted in either case and compared lower-cased; the generator emits lowercase. Required by `preserve`. Without it the installer hashes the download anyway and writes the hash to the log, but nothing can compare it with anything, so `tools/check.py` reports a part without one as a FAIL (`--allow-unhashed` lowers that to a warning). |

### `compatibility`, for the `preserve` profile

| Field | Type | Meaning |
|---|---|---|
| `regions` | array of `{offset, size, sha256}` | Flash regions that must already hold exactly these bytes, in both modes. `sha256` is required. |
| `firstInstall.regions` | same | Extra regions checked only in *first installation* mode. `sha256` is required. |
| `firstInstall.empty` | array of `{offset, size}` | Regions that must read back as all `0xff` in *first installation* mode. |
| `update.tableOffset` | integer ≥ 0 | Offset of the partition table. Required. In *update* mode the page requires the sector there to hold this release's table, padded with `0xff`. There must be a part at exactly this offset, and it must be the last part listed: parts are written in manifest order and the table has to go on the chip after the application. |

All of this is checked when the manifest is read, before the device is opened,
and each failure is `manifest.compatibility`: a region without `sha256` makes a
claim the installer cannot check; a missing `update.tableOffset`, or one that no
part is written at, leaves update mode with nothing to compare. The `preserve`
profile also needs at least one region between `regions` and
`firstInstall.regions`, it may not set `eraseAll`, and every one of its parts has
to start on a 4 KiB boundary (`manifest.alignment` otherwise). `tools/manifest.py`
refuses to write a `preserve` manifest that breaks any of these rules, and
`tools/check.py` reports one that does.

### `improv`, Wi-Fi setup after the install

After a successful install the page reopens the port at 115200 baud and asks,
for about ten seconds, whether the device speaks Improv Serial. A device that
answers gets one optional step on the done screen: pick a network from the ones
it can see, type the password, send. The device joins the network and, if it
reports an address of its own, that address is offered as a link. A device that
stays silent gets nothing; the install is already finished and verified, and the
technical log records that this system does not offer Wi-Fi setup here.

`improv` is what a release says about itself, and it is read three ways:

| Value | What the page does |
|---|---|
| absent | Asks anyway. A local file has no manifest, and a silent device costs nothing. |
| `true` | Asks, and if the device stays silent the log says so as a mismatch between the release and the device. |
| `false` | Does not ask. For firmware that puts the port to another use right after boot. |

Anything but a boolean is refused with `manifest.improv`. `tools/manifest.py`
writes `true` for `--improv` and leaves the key out otherwise; `tools/check.py`
reports a build that sets it and fails one that sets it to something else.

One more check applies to every part in both profiles: a part that is at least
24 bytes long and starts with the image magic `0xE9` must carry this chip
family's image id at bytes 12 and 13. That is what stops an application built
for another chip from being written in a `preserve` release, where nothing covers
the bootloader offset. A data part that happens to start with `0xE9` is refused
for the same reason; give it another first byte or ship it as an image.

## Example: a plain esp-web-tools manifest

This is `firmware/demo-1-0-0.json` in this repository, and it has no `schema`
key, so it is read as schema 1.

```json
{
  "name": "Demo firmware",
  "version": "1.0.0",
  "new_install_prompt_erase": true,
  "builds": [
    {
      "chipFamily": "ESP32",
      "parts": [
        {
          "path": "demo.bin",
          "offset": 4096,
          "size": 4096,
          "sha256": "c939cfc0405acccaa7433d7c80e4a9481acf94bb3e5bd5d072b680ace1677b6a"
        }
      ]
    }
  ]
}
```

## Example: schema 2, `factory`

Generated by the tool from the demo binary:

```
python3 tools/manifest.py firmware/demo.bin@0x1000 \
  --chip ESP32 --name "Demo firmware" --version 1.0.0 \
  --prompt-erase --out firmware/my-firmware-1-0-0.json
```

The output name is yours to choose. Do not point it at the shipped
`firmware/demo-1-0-0.json`: that file is the schema 1 example and the generator
would silently replace it with a schema 2 one.

```json
{
  "schema": 2,
  "name": "Demo firmware",
  "version": "1.0.0",
  "profile": "factory",
  "new_install_prompt_erase": true,
  "builds": [
    {
      "chipFamily": "ESP32",
      "parts": [
        {
          "path": "demo.bin",
          "offset": 4096,
          "size": 4096,
          "sha256": "c939cfc0405acccaa7433d7c80e4a9481acf94bb3e5bd5d072b680ace1677b6a"
        }
      ]
    }
  ]
}
```

The tool writes paths one or two directories above the manifest as `../` and
`../../`, and refuses anything deeper, because a web server rarely mirrors that:

```
manifest.py: demo.bin sits 6 directories above the manifest (…); a site rarely
mirrors that, so pass --path-prefix to say how it serves the file
```

Either put the manifest next to the binaries, or pass `--path-prefix` to say
under which path the site serves them.

## Example: schema 2, `preserve`

Built from three synthetic binaries in a temporary directory: a 4 KiB ESP32
bootloader image, a 3 KiB partition table and a 64 KiB application.

```
python3 tools/manifest.py partitions.bin@0x8000 app.bin@0x10000 \
  --chip ESP32 --name "Demo firmware" --version 2.0.0 --profile preserve \
  --board "M5Stack Core2" --board-key core2 --flash-mb 16 --usb 1a86:55d4 \
  --compat-region 0x1000:0x7000:98407b09f7cbc15d8bd846653ebae905622047013cd41b19d33f48c4345ebbb2 \
  --first-region 0x1000:0x7000:98407b09f7cbc15d8bd846653ebae905622047013cd41b19d33f48c4345ebbb2 \
  --first-empty 0x9000:0x6000 \
  --update-table 0x8000 \
  --out demo-2-0-0.json
```

```
wrote demo-2-0-0.json: Demo firmware 2.0.0, 2 parts, 68608 bytes
```

```json
{
  "schema": 2,
  "name": "Demo firmware",
  "version": "2.0.0",
  "profile": "preserve",
  "new_install_prompt_erase": false,
  "builds": [
    {
      "boardKey": "core2",
      "board": "M5Stack Core2",
      "chipFamily": "ESP32",
      "flashSizeMB": 16,
      "usbVendorId": 6790,
      "usbProductId": 21972,
      "compatibility": {
        "regions": [
          { "offset": 4096, "size": 28672, "sha256": "98407b09f7cbc15d8bd846653ebae905622047013cd41b19d33f48c4345ebbb2" }
        ],
        "firstInstall": {
          "regions": [
            { "offset": 4096, "size": 28672, "sha256": "98407b09f7cbc15d8bd846653ebae905622047013cd41b19d33f48c4345ebbb2" }
          ],
          "empty": [
            { "offset": 36864, "size": 24576 }
          ]
        },
        "update": { "tableOffset": 32768 }
      },
      "parts": [
        { "path": "partitions.bin", "offset": 32768, "size": 3072, "sha256": "12adc9dff80688800f2f591f0da6ab2f8109d61d910697801f57669ec0d719d3" },
        { "path": "app.bin", "offset": 65536, "size": 65536, "sha256": "b7d3dbe2d17eb3d45e4cfd3f68d99a2cc3cdfb8dcd205a8793f0dafe38e3bc07" }
      ]
    }
  ]
}
```

The region checksums are not computed from the release. They are measured on a
device you trust, which is the whole point: they say "this release was tested
against a device whose flash looks like this". Read the region off a reference
board with esptool's flash-read command, hash the resulting file with
`shasum -a 256`, and pass offset, size and that hash to `--compat-region`.

## `catalog.json`

The catalog is the index the page loads first. It lists the systems this site
installs, each with its releases. `site` is a free label for the publisher's own
use; the page does not read it. The shipped file has an empty `systems` list,
which makes a fresh copy open on the own-file path.

```json
{
  "site": "example",
  "allowOrigins": ["https://files.example.org"],
  "systems": [
    {
      "id": "demo",
      "name": "Demo firmware",
      "device": "Any ESP32 board",
      "guide": "https://example.com/demo/guide",
      "releases": [
        { "version": "2.0.0", "manifest": "firmware/demo-2-0-0.json", "channel": "pre" },
        { "version": "1.0.0", "manifest": "firmware/demo-1-0-0.json", "channel": "stable" }
      ]
    }
  ]
}
```

`id` is what goes in the URL. `name` and `device` are shown on the chooser.
`guide` is an optional link offered after a successful install; a release may
override it with its own `guide`.

### Ordering

**Releases are listed newest first, across all channels.** The page does not
parse version numbers and does not sort. It takes the first entry that matches,
in the order you wrote them, so the order in the file is the decision.

`tools/check.py` does parse versions, purely to warn when the file contradicts
itself:

```
WARN order demo: 2.0.0 is listed after 1.0.0 but is newer; the page takes the first match
```

### URL parameters

| Parameter | Effect |
|---|---|
| `?fw=<id>` | Install this system. Without it the page shows the list of systems. |
| `&v=<version>` | Install exactly this version. It is matched against `version` as written; no version parsing. |
| `&channel=pre` | Without `v`, take the very first release in the list, whatever its channel. That may well be a stable one. |
| *(no `channel`)* | Without `v`, take the first release whose `channel` is `stable`. A release with no `channel` counts as stable. A system that has no stable release at all falls back to its first release, so a pre-only system still opens. |
| `&lang=<code>` | Force a language. It wins over the page's own `lang` attribute, which in turn wins over the browser's languages, which win over English. `en` and `pl` ship with the page; an unknown code, or one with no dictionary, falls back to English. |

An unknown `fw`, or a `v` that matches nothing, stops the page with a message
saying the release is at fault, not the device.

### `allowOrigins`

By default every part has to come from the same origin as the manifest. That is
what makes the page safe to hand to a stranger: the release cannot quietly point
the download somewhere else.

`allowOrigins` in `catalog.json` is the escape hatch for a site that keeps its
binaries elsewhere, for example on a release host. It takes three steps, and the
page refuses the download until all three are done:

1. List the exact origins, scheme and host and port, no path:

   ```json
   "allowOrigins": ["https://files.example.org"]
   ```

2. Add the same origin to `connect-src` in the Content-Security-Policy meta tag
   of `index.html`. The policy ships as `connect-src 'self'`, and the browser
   enforces it before the installer's own check runs, so without this edit the
   fetch is blocked and the install stops with a download error:

   ```
   connect-src 'self' https://files.example.org
   ```

3. Run `python3 tools/check.py .`. It reads `allowOrigins` from the catalog and
   accepts exactly those origins in `connect-src`, and nothing else; an origin in
   the policy that the catalog does not list is a FAIL, and an origin in the
   catalog that the policy does not name is a WARN, because the page would
   refuse to fetch from it. An entry that is not `https:` is a FAIL and is not
   honoured at all: the installer is served over https and the browser blocks an
   `http:` download as mixed content. `http://localhost` and `http://127.0.0.1`
   are the exception, so local testing still works. An analytics host that must appear in `script-src`
   is a different case and is passed as `--allow-origin`; see
   [replicate.md](replicate.md#counting-downloads).

Two more things follow. The other host has to send permissive CORS headers,
because the page fetches the binaries with `fetch()`. And the origin check is
repeated on the *response*: redirects are followed, but if the bytes finally
arrive from an origin other than the one requested, the download is rejected.

## What `check.py` reports

`tools/check.py` takes a URL or a directory and reads the site the way the page
would: `index.html`, the vendored bundle, `catalog.json`, every manifest it
names, then every part of every manifest. Parts are downloaded in full, not
probed with a HEAD request, because the point is to compare real bytes against
the declared size and checksum.

```
python3 tools/check.py .
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

On a `preserve` release where nothing is written at the bootloader offset, the
chip line says so rather than inventing a verdict:

```
OK chip core2: nothing is written at the bootloader offset
```

A failure names the subject, the measurement and the claim:

```
FAIL sha256 core2: app.bin is b7d3dbe2d17eb3d45e4cfd3f68d99a2cc3cdfb8dcd205a8793f0dafe38e3bc07, manifest says 0000000000000000000000000000000000000000000000000000000000000000
SUMMARY 12 OK, 1 WARN, 1 FAIL
```

Checks it runs: the Content-Security-Policy meta tag in `index.html`, against
the origins the catalog lists in `allowOrigins` and those passed as
`--allow-origin`; for a live URL, whether the host sends `X-Frame-Options` or a
`Content-Security-Policy` response header with `frame-ancestors`, which the page
cannot set for itself; the checksum of the vendored esptool-js bundle against
`vendor/esptool-js/SHA256SUMS`; that the catalog lists systems and each system
lists releases; release ordering; manifest shape, schema, profile, board keys and
duplicates; for `preserve`, the compatibility block in full; per part the served
size and SHA-256; part ordering and overlap; the ESP image header of whatever
covers the chip's bootloader offset; and the image id of every other part that
starts like an image.

Warnings, not failures: a part with no declared `size`, parts not listed by
rising offset, and releases listed out of order. Those are all things the page
tolerates but a publisher probably did not mean.

A part with no declared `sha256` is a failure, not a warning: the page will write
it, and with no hash to compare, only the connection stands between the device and
a damaged or swapped file. `--allow-unhashed` lowers it to a warning for a build
pipeline that genuinely cannot hash its binaries. The flag says nothing about a
checksum that is present and wrong — that is a FAIL either way.

A directory is checked as if it were the site's root. When the installer is a
subdirectory of the site and a manifest names a file outside it (`../../os/…`),
pass `--site-root` with the directory the site's root URL corresponds to; see
[replicate.md](replicate.md#local-testing).

Exit codes: `0` nothing failed, `1` at least one FAIL, `2` the command was wrong.
