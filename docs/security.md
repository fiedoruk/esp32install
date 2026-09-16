# Security model

This page takes a file from the internet and writes it into the flash of a device
in front of you. That is the most privileged thing a web page can do to hardware
you own. This document says plainly what protects you and what does not.

## What the installer trusts

**The publisher.** Whoever controls the site controls the manifest, and the
manifest names the bytes. If you install from a site, you are trusting that
site's owner exactly as much as you would trust a downloaded `.exe`. No amount of
checksum verification changes that: the checksum proves the file arrived intact,
not that it is benign.

**The transport, once.** HTTPS is what makes the manifest and the binaries come
from the host you think they do. The installer requires a secure context anyway,
because Web Serial does.

**esptool-js.** The vendored library speaks the ESP bootloader protocol and does
the writing. The version is pinned and its SHA-256 is checked by `tools/check.py`,
so a replica can prove it is shipping the same bundle. What that bundle does once
it runs is trusted code.

**The browser.** Web Serial hands the page a port only after the person picks it
in the browser's own dialog. The page cannot enumerate ports, cannot pick one
silently, and gets nothing at all if the person closes the dialog.

## What the installer verifies

Every one of these is a hard stop. Some are checked before the device is opened
at all; the rest need the chip to answer first. Nothing is written until all of
them have passed.

Against the release:

- Every part URL resolves to the manifest's origin, or to an origin the site
  listed in `allowOrigins`. `http:` and `https:` only. Credentials in the URL are
  stripped.
- The response that finally delivers the bytes is on the origin that was
  requested, even after redirects.
- Declared `size` and declared `sha256` must both hold. A part with no checksum
  is hashed anyway and the hash is printed in the log, so it can be compared with
  the release notes by hand — but nothing on the page can compare it for you, so
  `tools/check.py` refuses such a manifest with a FAIL unless the publisher passes
  `--allow-unhashed`. The checker also refuses an `allowOrigins` entry that is not
  `https:`, apart from `localhost` and `127.0.0.1`.
- Size limits: no empty part, 32 MiB per part, 64 MiB in total.

Against the device:

- The flash size comes from the JEDEC id the chip returns, with no fallback to a
  guess. An id of `0x000000` or `0xffffff`, or a size code the vendored library
  has no entry for, stops the install.
- Nothing may reach past the end of flash, and no two parts may overlap.
- Whatever lands at the chip's bootloader offset must start with `0xE9` and carry
  this chip family's image id.
- Every other part that starts with `0xE9` and is at least a header long must
  carry this chip family's image id as well, so an application built for another
  chip is refused even in a `preserve` release that never touches the bootloader.
- A build is only offered when its declared chip family, flash size, USB ids,
  chip-description substrings and feature strings match the hardware present.
  Flash size is compared for equality, not capacity. USB ids are compared only
  when both the build and the port report them.

After writing:

- esptool-js compares its own hash of each image with the MD5 read back from the
  chip, and throws on any difference.
- The `preserve` profile reads the MD5 back again itself, then re-reads the flash
  header to prove that bytes outside the written parts are unchanged and that the
  sector padding around them reads `0xff`.
- A hard reset is attempted last, and a reset that fails does not fail the
  install: the image is written and verified by then, so the log says to press
  reset or replug instead.

Both profiles refuse a device with secure boot or encrypted flash before they
erase or write anything: the plaintext this installer sends would leave such a
board unable to start. The state comes from the ROM's security-info command, or,
on a chip whose ROM has none, from the efuses (`docs/profiles.md`, `preserve`
step 2). They differ in what an unreadable state means: `factory` installs anyway
and says so in the log, because it writes a whole layout to a device it makes no
promise about, while `preserve` refuses to write on a guess.

The `preserve` profile additionally checks the MAC address before and after every
long step, demands that the existing flash header match the manifest's regions, and requires a
whole-flash backup that was read twice, agreed with itself, was saved where the
user chose, and was read back from disk through the same file handle. Without a
save picker the user hands the downloaded file back instead.

## What the installer cannot verify

**That the firmware is honest.** A checksum says the bytes are the bytes the
publisher named. It says nothing about what they do. A malicious release with a
correct checksum installs perfectly.

**That the publisher is who they claim.** There is no code signing here, and no
chain of trust beyond the TLS certificate of the site you are on.

**ESP8266 images belong to this board.** ESP8266 firmware headers carry no chip
id, so only the `0xE9` magic byte is checked.

**ESP32-C61 images at the bootloader offset.** esptool-js 0.6.1 does not
declare a bootloader offset for that family, so the check at that offset is
skipped. Parts that start with `0xE9` are still checked for the C61 image id.

**That an unversioned part is the right one.** A manifest may omit `size` and
`sha256` outside the `preserve` profile, in which case there is nothing to
compare against. `tools/check.py` warns about exactly that, and the `preserve`
profile refuses it outright.

**What a previous flasher left behind.** In the `factory` profile without an
erase, anything not covered by the release stays on the chip.

## Content-Security-Policy

`index.html` carries a policy that keeps the page inside its own origin:

```
default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:;
style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none';
form-action 'none'
```

`script-src 'self'` with no `unsafe-inline` and no `unsafe-eval` means no inline
script and no string-to-code can run, so a manifest field that somehow reached
the DOM cannot become script. `connect-src 'self'` is the reason `allowOrigins`
needs a deliberate change to the page's policy as well as to the catalog if you
move binaries off-origin: the origin has to be added to `connect-src` in
`index.html`, and `tools/check.py` then accepts it there because the catalog
lists it. `form-action 'none'` and `base-uri 'none'` remove two classic
redirection tricks. The page also sets `referrer: no-referrer`, so visiting an
installer link does not tell the firmware host where you came from.

`connect-src 'self'` also decides what the own-file path's address field can
read. A path on the same site works as it is; an address on another origin is
blocked by the browser before any request is made, and the page reports that as
`own.blocked` with the suggestion to download the file and choose it from disk.
That is the shipped default and this product does not change it. A host that
wants arbitrary addresses to work opts in by adding the scheme to the
directive, `connect-src 'self' https:`. The trade-off is that the page may then
read any `https:` address the visitor types, including one they would not have
found on their own. What does not change: every byte read that way is measured,
held to its size and SHA-256 before the first write, shown with that hash in the
technical layer, and checked against the chip that is plugged in. The catalog
path is unaffected either way, because a manifest's parts stay held to the
manifest's origin and `allowOrigins`. [replicate.md](replicate.md#without-a-catalog)
shows the edit and what `check.py` says about it.

One directive is deliberately absent. `frame-ancestors`, which stops another
site from framing the installer and steering clicks at it, is ignored by
browsers when it appears in a `<meta>` policy and only logs a console error
there. It belongs in an HTTP header set by the host, together with the older
`X-Frame-Options`; [replicate.md](replicate.md#what-the-host-has-to-do) shows
where. Until the host sends it, the page can be framed — though Web Serial is not
delegated to cross-origin frames by default, so what a framing site gains is the
visitor's clicks, not their device. `tools/check.py` given a URL reads the
response headers and says `WARN framing` when neither header is there; given a
directory it says nothing, because a directory has no headers.

`tools/check.py` fails if that meta tag is missing, if `default-src` is not
exactly `'self'`, or if `script-src`, `script-src-elem`, `connect-src` or
`style-src` name anything beyond `'self'` that was not declared: origins from the
catalog's `allowOrigins` are accepted in `connect-src`, and origins passed as
`--allow-origin` (a host's own analytics) are accepted in `script-src`,
`script-src-elem` and `connect-src`. `style-src` and `default-src` never widen.
That makes weakening the policy a visible act rather than a silent one, and it
ships with no third party of anyone's baked in.

## No CDN

Every byte the page loads comes from the same origin: the esptool-js bundle, the
fonts, the stylesheets, the locale files. Nothing is fetched from a third party,
so there is no script host that could be compromised into changing what gets
written to your device, and the page keeps working on an air-gapped network.

That is also why the fonts are vendored with their licences and checksums rather
than linked.

## No telemetry

The product sends nothing anywhere. It has no analytics, no error reporting and
no update check.

It does call `window.__esp32installAnalytics(name, props)` when the surrounding
site has defined that function. `start` carries the system id and the version,
because at that point no device has been read. `done` adds the chip family.
`error` adds the chip family, the stage and the error code. The installer never
defines it. A site that wants to count installs opts in by writing that function;
a replica that does nothing sends nothing.

## Backups contain your data

A whole-flash backup is a copy of everything on the device. On a typical ESP32
that includes the NVS partition, and NVS is where Wi-Fi SSIDs and passwords live,
along with tokens, pairing keys and whatever else the firmware stored.

The file never leaves your computer: it is produced in the browser and saved
through the system's save dialog, or the normal download on a browser without
one. The page sees the file name you chose and a handle it can read back; it
never learns the folder path, because browsers do not expose it. But once the
copy is on disk it is an unencrypted copy of your device's secrets.

Keep it private. Do not attach it to a bug report, do not put it in a public
repository, and do not hand it to a stranger who offers to look at your device.
If you no longer need it, delete it.

## Reporting a problem

See [SECURITY.md](../SECURITY.md).
