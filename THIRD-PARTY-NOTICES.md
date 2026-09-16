# Third-party notices

esp32install is MIT licensed (see `LICENSE`). It redistributes the components
below. Their licences are reproduced in the repository next to the files they
cover.

Every vendored binary has its SHA-256 recorded so a replica can prove it ships
the same bytes. `tools/check.py` verifies the esptool-js checksum on every run,
and the Improv client's whenever the client is shipped.

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

## improv-wifi-serial-sdk 2.8.1

- **Licence:** Apache License 2.0 — full text in `vendor/improv-wifi/LICENSE`
- **Project:** <https://github.com/improv-wifi/sdk-serial-js>
- **Files:** four of the package's `dist/` files, the headless protocol client
  only. The package's launch button, its provisioning dialog and their Lit and
  Material dependencies are not included.
  - `vendor/improv-wifi/serial.js` (21 386 bytes) —
    `ab4a7eadd9c03f13f1d7fdc36d64b8b7466d194e3c84f037f64c495ca912a5c6`
  - `vendor/improv-wifi/const.js` (1 501 bytes) —
    `350499f3d5b19dd3e473f95fb31a0226c4df5000e4742761963a6e79d07fda1b`
  - `vendor/improv-wifi/util/hex-formatter.js` (135 bytes) —
    `d9212496c7fcbc967c5419f0fcb866727e5eb35abe0f5ab8ba661a03392ce015`
  - `vendor/improv-wifi/util/to-hex.js` (257 bytes) —
    `4fb4eab465268c38bf9e1efb05b378acdefdf2ffb8768ec3d4c753da063f1ca1`
- **Recorded in:** `vendor/improv-wifi/SHA256SUMS`

This is the client that speaks Improv Wi-Fi Serial: it asks a freshly installed
device whether it takes Wi-Fi credentials over the cable, lists the networks the
device sees and hands over the name and password. It is used only after an
install has finished and verified, and only if the device answers.

**Modification.** Two import specifiers in the upstream files have no `.js`
extension (`./util/hex-formatter` in `serial.js`, `./to-hex` in
`util/hex-formatter.js`), which a browser cannot resolve without a bundler.
The shipped copies add the extension, three bytes each, and nothing else. The
upstream files hash to `25dce28ec070c0c7f52b47bca8461dded996441b0d827c77fd6d16902061ab13`
and `8b0d3ce97173814c4effac0218a3b326110e0678add1e26f99a0f24c39596d4c`;
`tests/vendor.improv.test.js` reverses the patch and checks both. The other two
files are byte for byte the upstream ones.

The Improv Wi-Fi maintainers hold the copyright. This project is not affiliated
with, endorsed by or supported by them.

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
