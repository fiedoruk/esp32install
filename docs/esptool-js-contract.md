# esptool-js 0.6.1 — the contract this installer relies on

Verified against the npm package (lib/esploader.d.ts, lib/targets/*.js) on 2026-09-15.
The two `command` entries below were re-read in the vendored bundle on 2026-09-16, when the
security gate stopped using `checkCommand`.

- `new Transport(port: SerialPort, tracing=false, enableSlipReader=true)`; `transport.setDeviceLostCallback(fn)`; `transport.disconnect()`.
- `new ESPLoader({ transport, baudrate, terminal: {clean, write, writeLine}, debugLogging })`.
- `loader.main(mode='default_reset')` → detects chip, runs stub, changes baud; returns chip description string. Sets `loader.chip` (ROM).
- `loader.chip.CHIP_NAME` ('ESP32', 'ESP32-S3', 'ESP32-C3', 'ESP32-C6', 'ESP32-C5', 'ESP32-P4', ...),
  `loader.chip.BOOTLOADER_FLASH_OFFSET` (ESP32/S2: 0x1000; S3/C3/C6/H2/C2: 0x0; C5/P4: 0x2000; C61: not declared in 0.6.1),
  `loader.chip.IMAGE_CHIP_ID` (ESP32 0, S2 2, S3 9, C3 5, C6 13, C5 23, C61 20, H2 16, P4 18, C2 12),
  `loader.chip.getChipDescription(loader)`, `getChipFeatures(loader)` → string[], `readMac(loader)` → string.
- `loader.readFlashId()` → number (JEDEC id); size code = `(id >> 16) & 0xff`; `loader.DETECTED_FLASH_SIZES[code]` → '4MB' etc. or undefined.
  We do NOT use `detectFlashSize()` because it silently defaults to 4MB.
- `loader.command(op, data, chk, waitResponse, timeout)` → `[value, data]`, where `data` is the reply
  with the two status bytes still on the end. This is what `app/security.js` uses for the security-info
  command `0x14`; it slices the status bytes off itself, the way esptool.py's `check_command` does.
  The payload is 12 bytes on ESP32-S2 and 20 on ESP32-S3 and newer, and both shapes carry the two
  fields the gate reads in their first five bytes.
- `loader.checkCommand(desc, op, data, chk, resplen, timeout)` exists and is **not** used for `0x14`.
  It demands `resplen + 2` bytes and throws on anything shorter, so `resplen` 20 turns an ESP32-S2's
  12-byte answer into an exception, and `resplen` 12 makes it read two bytes of the chip id as the
  status bytes of a 20-byte answer. Neither length is right for both, which is why the raw `command`
  is called instead.
- `loader.chip.readEfuse(loader, word)` → number. Declared on `ESP32ROM` in the bundle and inherited by the
  later families, but it reads `this.EFUSE_RD_REG_BASE`, which only the classic ESP32 sets to its block-0 base
  (`0x3FF5A000`). `app/security.js` therefore calls it for `ESP32` alone, as the fallback for chips whose ROM
  has no command 0x14.
- `loader.readFlash(addr, size, onPacket?)` → Uint8Array.
- `loader.eraseFlash()` → whole-chip erase (stub required).
- `loader.writeFlash({ fileArray:[{data, address}], flashMode:'keep', flashFreq:'keep', flashSize:'keep', eraseAll:false, compress:true, reportProgress(fileIndex, written, total), calculateMD5Hash(image)→hex })`.
  When `calculateMD5Hash` is given, esptool-js compares it with `flashMd5sum` read from the chip after each file and throws on mismatch.
- `loader.after('hard_reset')`.
- `loader.flashMd5sum(addr, size)` → hex string (used by the preserve profile for read-back cross-check).

## Measured findings (line numbers in the npm package, not the bundle)

These three points were read out of the shipped source rather than assumed. Line
numbers refer to `lib/esploader.js` and `lib/esploader.d.ts` of esptool-js 0.6.1.

**1. `writeFlash` does verify the MD5 itself, and it throws.** `lib/esploader.js`
declares `async writeFlash(options)` at line 1314. When `options.calculateMD5Hash`
is supplied it is called at line 1341 on the image *after*
`_updateImageFlashParams` (line 1338) and *before* compression, so the hash covers
the flash-parameter-patched bytes that actually reach the chip. After each file is
written, lines 1448-1457 run `this.flashMd5sum(address, uncsize)` (line 1450),
compare it with the value we returned (line 1452) and
`throw new ESPError("MD5 of file does not match data in flash!")` on mismatch
(line 1453). No separate verification pass is needed for the write path; our own
`flashMd5sum` cross-check is only required where we read back flash we did not
write.

**2. `main()` returns the chip description string.** `async main(mode = "default_reset")`
starts at line 1146. It assigns `const chip = await this.chip.getChipDescription(this)`
(line 1148) and ends with `return chip;` (line 1176); `lib/esploader.d.ts` line 373
types it as `main(mode?: Before): Promise<string>`. Between those points it calls
`detectChip`, `runStub`, and `changeBaud` when `romBaudrate !== baudrate`, and it
throws `ESPError("Unable to verify flash chip connection ...")` if `readFlashId`
fails. A flash id of `0xffffff` or `0x000000` is only logged as a warning, not
thrown, so the caller must treat those values as a dead flash chip itself.

**3. `DETECTED_FLASH_SIZES` is a public instance property.** It is assigned in the
constructor at `lib/esploader.js` line 121 and declared in `lib/esploader.d.ts`
line 49 as `DETECTED_FLASH_SIZES: { [key: number]: string }`. Reading
`loader.DETECTED_FLASH_SIZES[code]` is therefore supported API, not an internal.
It has no entry for every possible JEDEC size code, so an unknown code yields
`undefined`. `detectFlashSize()` (lines 1473-1486) papers over exactly that case by
falling back to the string `"4MB"` at line 1479, which is why we read the table
directly instead.

**4. `ESP8266` declares `BOOTLOADER_FLASH_OFFSET = 0x0` and no `IMAGE_CHIP_ID`.** Measured
in the vendored bundle `vendor/esptool-js/esptool-js-0.6.1.js` by extracting the class
whose `CHIP_NAME="ESP8266"` (2026-09-15): the offset is declared as `0`, the chip id is
absent (the ESP8266 image header has no chip id field). `verify.js` therefore checks
only the `0xE9` magic for ESP8266 and skips the chip id comparison. `ESP32-C61` is the
only class in the bundle without a `BOOTLOADER_FLASH_OFFSET`.

## Consequences for `engine.js`

- `fileArray[].data` is a `Uint8Array` in 0.6.1 (`lib/types/flashOptions.d.ts`),
  not the binary string older esptool-js releases expected.
- `command` resolves to a tuple, so the security-info read takes `reply?.[1]` and checks
  that it is a `Uint8Array` long enough to hold the status bytes before it indexes anything.
  A reply that is neither is an unreadable answer, never an absent command.
- `getChipDescription`, `getChipFeatures` and `readMac` are all async on the ROM
  base class (`lib/targets/rom.d.ts` lines 31, 37, 55) and must be awaited.
- `BOOTLOADER_FLASH_OFFSET` is `abstract` in `lib/targets/rom.d.ts` (line 74) and
  `lib/targets/esp32c61.js` never assigns it, so it is `undefined` on ESP32-C61.
  Any offset arithmetic must handle that rather than trusting the base class.
