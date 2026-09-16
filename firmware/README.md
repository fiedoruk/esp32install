# `firmware/` — the demo release

This directory holds one example release for the test suites and for trying
`tools/check.py` against a manifest by hand. It is not a product, and it is
deliberately **not listed in `catalog.json`**: a fresh copy of the site opens
on the own-file path and offers nothing to install until you add a release of
your own.

## The files

**`demo.bin`** — 4 096 bytes, SHA-256
`c939cfc0405acccaa7433d7c80e4a9481acf94bb3e5bd5d072b680ace1677b6a`.

It is a dummy. Every byte is `0xff` except two things that make it look like an
ESP32 image to the installer's header check: the first byte is the ESP image
magic `0xE9`, and bytes 12 and 13, which hold the image chip id, are zero, which
is the id for ESP32. The manifest places it at offset `4096` (`0x1000`), the
bootloader offset for that family, so the check finds a valid header exactly
where it looks for one.

**`demo-1-0-0.json`** — the manifest for that file. It has no `schema` key, so it
is read as a plain esp-web-tools manifest (schema 1), which keeps that path
exercised. It declares `size` and `sha256` for the part and sets
`new_install_prompt_erase`.

`catalog.json` in the repository root does not list it. It used to, and a
fresh copy then showed a button that would write this dummy to a real board;
see the next section for why that must not happen. To see the checker run over
it, list it in a scratch catalog yourself:

```json
{ "site": "example", "systems": [ { "id": "demo", "name": "Demo firmware", "device": "Any ESP32 board",
  "releases": [ { "version": "1.0.0", "manifest": "firmware/demo-1-0-0.json", "channel": "stable" } ] } ] }
```

## Do not flash this to a device

`demo.bin` contains no code. It is a header and 4 KiB of blank flash.

Writing it to a real board at `0x1000` overwrites the bootloader with something
that cannot boot, and the board will not start until a real bootloader is written
back. There is nothing to gain from trying: the page will run through its whole
flow and leave you with a device that does nothing.

It exists to be *verified*, not installed.

## Where a replica puts its own files

The same place. This directory is the convention, not a requirement: a part's
`path` is resolved against the URL of the manifest that names it, so any layout
works as long as the manifest sits at a known place and the binaries are reachable
from it.

The simplest arrangement, and the one `tools/manifest.py` expects by default, is
the manifest next to its binaries:

```
firmware/
  mysystem-1-2-0.json
  bootloader.bin
  partitions.bin
  mysystem.bin
```

`tools/manifest.py` writes binaries one or two directories above the manifest
as `../` paths and refuses anything deeper, because a web server rarely mirrors
that; pass `--path-prefix` when the site serves them under a different path.

Keeping every release's files under their own version-stamped names, rather than
overwriting a single `firmware.bin`, is what makes an old `&v=` link keep working
for a device in the field that needs the version it was tested with.

Adding your own release is a matter of putting your files here, generating a
manifest, and listing it in `catalog.json`; the two demo files can stay or go. See [../docs/manifest.md](../docs/manifest.md) and
[../docs/replicate.md](../docs/replicate.md).
