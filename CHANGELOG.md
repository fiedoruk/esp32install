# Changelog

What changed between released versions. The only supported way to update a copy
is to replace the files with the current ones, so this page exists for the
question "does the copy I am running have that fix?".

## 0.3.1 — 2026-09-16

**Replace 0.3.0 if you have it.** It refuses every classic ESP32.

### A classic ESP32 was told it was locked when it was not
Reported from a stock, unlocked M5Stack Core2 (ESP32-D0WDQ6-V3): the page stopped with
*"This device is locked by its maker (secure boot or encrypted flash), so nothing was
written."* and wrote nothing.

`get_security_info` is defined from the ESP32-S2 onwards. The classic ESP32 has no such
command, and its reply to it is not the ROM's invalid-command code we recognised — it is
status 255. That was read as an unreadable answer, which 0.3.0 had deliberately made a
hard stop so that a timeout could never be mistaken for a missing command. Both decisions
were right on their own and wrong together.

A family that cannot have the command is no longer asked for it, exactly as the ESP8266
already was; the classic ESP32 goes straight to its efuses, where esptool looks too.
Nothing about a locked device changes: efuses that say locked still refuse, and the
ESP32-S2 and later path is untouched.

## 0.3.0 — 2026-09-16

This release is about the copy on **your** server rather than about ours. Nothing
here changes what the installer writes to a device.

### Your copy stops serving yesterday's files
A part's path may now carry its own checksum — `firmware.bin?sha256=<hex>`. The
address changes whenever the contents change, so a browser, a proxy or a CDN
cannot hand out the previous build. This works on a host whose cache headers you
cannot configure, which is most of them. `tools/manifest.py` writes these paths by
default; `--no-checksum-in-path` opts out, and a manifest with bare paths keeps
working exactly as before.

### The chip is asked to confirm the write against the release
A part may declare `md5`, and after writing the installer asks the chip for the
MD5 of what is actually in that region and compares it with the value the
publisher declared. This sits beside the existing check against the bytes that
were sent, so a bad write now fails two independent tests instead of one.

### The release decides how it is written
`flashMode`, `flashFreq` and `baudRate` belong in the manifest. They are
properties of an image, not of the page that installs it. Defaults are unchanged
when a manifest says nothing.

### Large files survive a bad connection
Parts are fetched in ranges and a broken download resumes instead of starting
over. A server that does not support ranges still works, in one request, as before.

### The installer can read the device's own layout
It reads the partition table from the device, shows it in the technical layer, and
when the `preserve` profile refuses because the layout is not the one the release
expects, it now says **what the device actually has** rather than only an offset.

### Smaller things
A footer in your own language through `site.<lang>.json`. A browser bar that takes
the colour of the page on a phone, an icon for the home screen, and a web manifest
that does not pretend the page is an app. The disabled install button is readable
again: it was white on pale blue at 2.6:1, which is a contrast failure that
automated checking misses because it skips disabled controls. On the own-file path
the heading now answers the question the button is waiting on. Hatch labels use one
grammar, and the log hatch no longer changes its own label under your finger.

### The footer credits the project
The mark in the footer is now a link to the repository. It is the only thing this
project asks for and it is deliberately one line to delete — `docs/replicate.md`
says which one.

## 0.2.0 — 2026-09-16

Everything below landed after 0.1.0 was tagged. Two of the changes are reasons to
replace an older copy rather than preferences; they are the first two.

### Security

- **Both profiles now ask the chip whether secure boot or flash encryption is
  on** before anything is erased or written. In 0.1.0 only `preserve` asked, so a
  `factory` install wrote a plaintext image to a locked board and left it unable
  to start. The answer comes from the ROM's security-info command, or from the
  efuses on a classic ESP32 whose ROM has none. The two profiles differ only in
  what an unreadable answer means.
- **The `preserve` profile enforces the 4 KiB rules.** A part must start on a
  sector boundary, and the sectors a write erases without filling them may not
  reach a declared region, another part or the end of the flash. 0.1.0 had
  neither rule, so a part starting mid-sector blanked up to 4 095 bytes of the
  user data that profile exists to keep, in a place the read-back does not look.
- The security-info answer is read at the length the chip gives it — 12 bytes on
  ESP32-S2, 20 on ESP32-S3 and newer — and a chip that does not answer at all is
  no longer mistaken for a chip without the command.
- A build that declares `eraseAll` now asks before it erases, and the dialog says
  that settings cannot be kept this time. It used to erase without a question.
- A `preserve` manifest whose partition table is not the last part listed is
  refused by the page, as it already was by both command-line tools.
- Link addresses are read the way the browser will read them, so a scheme that
  only looks safe no longer survives.
- Only `DENY` and `SAMEORIGIN` count as framing protection; other values are
  reported as no protection, which is what browsers do with them.
- `tools/check.py` fails a part with no `sha256`, and an `allowOrigins` entry
  that is not `https:`.

### New

- **Install a file of your own**, from disk or from an address, with the same
  checks a catalogued release gets. Up to six files, one row each, with the
  address a build tool would have used suggested from each file's own header and
  editable.
- **Wi-Fi over the cable.** After a successful install the page asks whether the
  device speaks Improv Serial and, if it does, offers one optional step to send
  it a network and a password.
- **What the device says.** A serial console inside the technical log, on the
  done screen and the stopped screen alike, so a failed boot can be read without
  another tool.
- **A light and a dark theme**, chosen by hand and restored before the first
  paint.
- **A footer the deployment fills in** from `site.json`, which belongs to the
  deployment exactly as `catalog.json` does. The bottom row carries the
  installer's own version, which is what someone reporting a problem should quote.
- The system list carries each release's version and channel and its own address
  to copy; the highlighted row is the newest release only while that release is
  a stable one.
- `tools/manifest.py --chip` takes the esptool spelling as well as the family
  name. `tools/check.py` reads response headers on a live URL and warns when
  nothing stops the page being framed.

### Changed

- **The shipped `catalog.json` lists no systems.** A fresh copy therefore opens
  on the own-file path instead of offering a demo release nobody published.
  `tools/check.py` reports that as a `WARN`, not a failure, and exits 0.
- The backup is saved where the user chooses and read back through the same
  handle before the first write.
- The erase dialog has three buttons: Cancel first and focused, the answer that
  installs without erasing in the middle, and the erase last.

### Third-party

- Added: the headless protocol client from improv-wifi-serial-sdk 2.8.1,
  Apache-2.0, four files with no dependencies, vendored and checksum-pinned. Two
  import specifiers carry a `.js` extension the upstream files lack; both hashes
  are recorded and a test proves that is the only difference.
- Unchanged: esptool-js 0.6.1 (Apache-2.0, with pako 2.1.0 embedded) and three
  font families under the SIL Open Font License 1.1.

### Still not measured on hardware

The secure-boot gate has been exercised against fakes, not against a board with
the fuses blown, and the 12-byte security-info shape is read out of esptool's own
branch rather than off an ESP32-S2. The browser list (Web Serial in Firefox 151
and newer, and in Opera) is consistent everywhere it is written down, but nothing
in this repository measures it.

## 0.1.0 — 2026-09-16

First public release. A browser page that writes firmware to an ESP32 over a USB
cable: static files, no build step, no bundler, no CDN. Origin, size, checksum,
layout, flash size and chip identity checked before a byte is written, and the
flash read back afterwards. Firmware of your own goes in behind one JSON
manifest.

**Do not run this one.** It has no secure-boot gate on the `factory` profile and
no alignment rules in `preserve`; both are listed under 0.2.0 above.
