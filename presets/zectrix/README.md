# ZECTRIX NOTE4C preset

A ready-to-host copy of this installer, configured for one device and one firmware:
**emini Home** on the **ZECTRIX NOTE4C DevKit**.

Download the bundle from the releases page, unpack it, and copy the directory to any server that
serves it over HTTPS. There is nothing to build and nothing to configure: open the page and it works.

## What is inside

| | |
|---|---|
| `catalog.json` | the one system this copy offers, with its two releases |
| `site.json` | the footer: whose copy this is and where it leads |
| `manifests/` | one manifest per release, with paths relative to this directory |
| `firmware/emini-home/<version>/` | the images themselves, with their `SHA256SUMS` |

Everything else is the installer, unchanged from the repository.

## Why only one device

The ZECTRIX line shares one chip, one board and one USB path: NOTE4, NOTE4 DevKit and NOTE4C DevKit
are all ESP32-S3 with 16 MB of flash and native USB. Only the panel differs, and the display drivers
are not interchangeable — writing a monochrome build to a four-colour panel is the one mistake that
costs a device.

This preset therefore offers only what it can stand behind: firmware we build ourselves, for the
panel we build it for. There is no monochrome build here because we do not make one. For the NOTE4
DevKit and for the finished NOTE4, use ZECTRIX's own tools.

**Nothing identifies the model over USB.** No vendor id, no fuse, no probe. If you adapt this preset,
keep the model a named row the visitor chooses, never a guess the page makes.

## What installing does to the device

emini Home ships in the `preserve` profile: the installer writes the partition table and the
application, and never touches the bootloader or the settings. Before the first byte it takes a
verified copy of all 16 MB, reads it back from the file you saved, and compares it. That copy is the
only way back — no factory recovery image is published for this hardware by anyone, including us.

The page refuses to write if the chip reports secure boot or flash encryption, if the layout on the
device is not the one the release expects, or if any checksum disagrees. Each of those stops before
the device is touched, and says which one it was.

## Putting your own firmware here instead

Replace `catalog.json`, `site.json`, `manifests/` and `firmware/` with your own. The format is
documented in the repository: see `docs/manifest.md` for the manifest and `docs/replicate.md` for the
server side. This preset is not a special build — it is the same files with three of them filled in.
