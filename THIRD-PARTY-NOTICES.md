# Third-party notices

esp32install is MIT licensed (see `LICENSE`). It redistributes the components
below. Their licences are reproduced in the repository next to the files they
cover.

Every vendored binary has its SHA-256 recorded so a replica can prove it ships
the same bytes. `tools/check.py` verifies the esptool-js checksum on every run.

## esptool-js 0.6.1

- **Licence:** Apache License 2.0 — full text in `vendor/esptool-js/LICENSE`
- **Project:** <https://github.com/espressif/esptool-js>
- **File:** `vendor/esptool-js/esptool-js-0.6.1.js` (218 551 bytes)
- **SHA-256:** `ef7d5a237d3f273ecf546bcee65dddad90bd82cf02f22a980d1537e0cd79a152`
- **Recorded in:** `vendor/esptool-js/SHA256SUMS`

This is the library that speaks the ESP bootloader protocol: chip detection,
stub loader, flash read and write, MD5 read-back and reset. It is vendored rather
than loaded from a CDN so that the page has no third-party origin at all. The
exact API surface this project depends on is written down in
`docs/esptool-js-contract.md`.

Espressif Systems holds the copyright in esptool-js. This project is not
affiliated with, endorsed by or supported by Espressif.

### pako 2.1.0, inside that bundle

The esptool-js bundle embeds pako for deflate, which is how firmware is
compressed on the way to the chip. Its licence header survives minification and
is the only such header in the file:

```
/*! pako 2.1.0 https://github.com/nodeca/pako @license (MIT AND Zlib) */
```

- **Licence:** MIT AND Zlib
- **Project:** <https://github.com/nodeca/pako>

No other third-party licence header appears in the bundle. The `atob` call it
makes is the browser's own global, not a package.

## Fonts

Three families are vendored under `assets/fonts/`, each with the full SIL Open
Font License 1.1 text beside it. Checksums are recorded in
`assets/fonts/SHA256SUMS`.

### Figtree

- **Licence:** SIL Open Font License 1.1 — `assets/fonts/figtree/OFL.txt`
- **Copyright:** Copyright 2022 The Figtree Project Authors
  (<https://github.com/erikdkennedy/figtree>)
- **File:** `assets/fonts/figtree/Figtree[wght].woff2`
- **SHA-256:** `6b96ce6d4783658f09e2b92d468da8e542d57aa6e4bc461ab2e7ae71565fdc64`

### Source Sans 3

- **Licence:** SIL Open Font License 1.1 — `assets/fonts/source-sans-3/OFL.txt`
- **Copyright:** Copyright 2010-2024 Adobe (<http://www.adobe.com/>), with
  Reserved Font Name 'Source'. All Rights Reserved. Source is a trademark of
  Adobe in the United States and/or other countries.
- **Files and SHA-256:**
  - `assets/fonts/source-sans-3/SourceSans3-Regular.ttf.woff2` —
    `53492fb3a0def77354f166a55d09b63a10855e91c206c7620a81cf56e97f8ec3`
  - `assets/fonts/source-sans-3/SourceSans3-Semibold.ttf.woff2` —
    `47b9b661b9f395fe7f0d0e119637fba5c8dad97bde3df60066fd24229c0792f4`

### Recursive Mono Casual

- **Licence:** SIL Open Font License 1.1 — `assets/fonts/recursive/OFL.txt`
- **Copyright:** Copyright 2020 The Recursive Project Authors
  (<https://github.com/arrowtype/recursive>)
- **File:** `assets/fonts/recursive/RecursiveMonoCslSt-Regular.woff2`
- **SHA-256:** `2532c079ce31f56334660db6f8ea28c9e67aaf79ed4911f0b9c1d4a348223ee3`

The SIL Open Font License permits redistribution and embedding, including in a
bundle sold or given away, provided the font files are not sold on their own and
the licence travels with them. Both conditions are met by keeping `OFL.txt` next
to each family, which is why a replica that swaps in its own fonts should remove
the unused families and their `OFL.txt` files rather than leaving them behind.

## Trademarks

"ESP32", "ESP8266" and "ESP" are trademarks of Espressif Systems. They are used
here only to name the hardware this tool writes to. Other names may be trademarks
of their respective owners.
