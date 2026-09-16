/**
 * Is this chip locked by its maker? Both profiles ask before they touch the flash, because
 * writing plaintext to a board with flash encryption or secure boot leaves it unable to start.
 *
 * The answer comes from the ROM's security-info command (0x14) where that exists, and from the
 * efuses where it does not. `unknownIsLocked` is the only difference between the callers: the
 * `preserve` profile writes into a device it promises to keep working and refuses to guess, while
 * a `factory` install may go ahead on a chip that cannot say, because that is every classic ESP32
 * whose efuses could not be read.
 *
 * Three answers, three different routes, and the difference matters: a ROM that says "I have no
 * such command" hands the question to the efuses, a ROM that answers is believed, and a chip that
 * does not answer at all — a timeout, a serial error — stops the install on both profiles. The
 * gate used to collapse all three into the first, which let a flash-encrypted ESP32-S2 through.
 */
import { InstallError } from './errors.js';

const COMMAND = 0x14;
// What the ROM answers with. An ESP32-S2 sends 12 bytes (flags, the flash-encryption count and
// seven key purposes); an ESP32-S3 and everything newer send 20, adding the chip id and the ROM's
// api version. esptool branches on exactly that (`len(res) == 12`), and the two fields this gate
// reads sit in the first five bytes of both shapes. NOT MEASURED on hardware: no ESP32-S2 here,
// so the 12-byte shape is read out of esptool's branch and the length rule out of the vendored
// bundle, not off a board.
const MIN_INFO_BYTES = 12;
const STATUS_BYTES = 2;
// The ROM's answer for a command it does not have: the status byte is non-zero and the byte after
// it is this. esptool-js calls it ROM_INVALID_RECV_MSG and raises "unsupported command error"
// when the reply also carries the wrong opcode.
const ROM_INVALID_COMMAND = 0x05;
const INFO_TIMEOUT = 5000;
const fail = (code, params = {}) => { throw new InstallError(code, params); };
const hex = (n) => '0x' + n.toString(16);

// Classic ESP32 block-0 efuses, as esptool reads them: FLASH_CRYPT_CNT is seven bits at bit 20 of
// word 0 and means "encrypted" when an odd number of them are blown; ABS_DONE_0 and ABS_DONE_1,
// bits 4 and 5 of word 6, mean secure boot v1 and v2. esptool only consults the second bit on
// chip revision 3 and later; reading both without asking the revision can only refuse a board,
// never write to a locked one, which is the direction to err in. NOT MEASURED on hardware.
const CRYPT_COUNT_SHIFT = 20;
const CRYPT_COUNT_MASK = 0x7f;
const SECURE_BOOT_WORD = 6;
const SECURE_BOOT_MASK = 0x30;

const oddBits = (n) => { let bits = 0; for (let v = n; v; v >>>= 1) bits ^= v & 1; return bits === 1; };

/** The two block-0 words, or null when this chip cannot be read that way. */
async function esp32Efuses(loader, log) {
  if (typeof loader.chip?.readEfuse !== 'function') return null;
  try {
    const word = async (n) => {
      const value = await loader.chip.readEfuse(loader, n);
      if (!Number.isFinite(value)) throw new Error(`efuse word ${n} read as ${value}`);
      return value >>> 0;
    };
    return { crypt: await word(0), boot: await word(SECURE_BOOT_WORD) };
  } catch (err) {
    log('efuses: ' + (err?.message ?? err));
    return null;
  }
}

/**
 * Ask the ROM command 0x14 and hand back its payload.
 *
 * We send it through `command()` and slice the status bytes off the end ourselves, exactly as
 * esptool.py's `check_command` does (`data[:-STATUS_BYTES_LENGTH]`), instead of calling the
 * vendored `checkCommand`. That helper demands `resplen + 2` bytes and throws on anything
 * shorter, so asking for 20 turned every ESP32-S2's 12-byte answer into an exception — which
 * this gate then read as "this ROM has no such command" and waved through. Asking for 12 is no
 * fix either: `checkCommand` looks for the status bytes at a fixed place, so on a 20-byte answer
 * it would read two bytes of the chip id and call a healthy chip a failure.
 *
 * The answer is one of:
 *   `{ payload }`      the ROM answered, status ok;
 *   `{ absent, why }`  the ROM says it has no such command — the efuses may still know;
 *   `{ unreadable, why }` a timeout, a serial error or a reply we cannot read. NOT an absent
 *                      command, and never treated as one.
 */
async function askRom(loader) {
  let reply;
  try {
    reply = await loader.command(COMMAND, new Uint8Array(0), 0, true, INFO_TIMEOUT);
  } catch (err) {
    const why = String(err?.message ?? err);
    // esptool-js throws this when the ROM replies with the wrong opcode and ROM_INVALID_RECV_MSG.
    if (/unsupported command/i.test(why)) return { absent: true, why };
    return { unreadable: true, why };
  }
  const data = reply?.[1];
  if (!(data instanceof Uint8Array) || data.length < STATUS_BYTES) {
    return { unreadable: true, why: `the reply carried ${data instanceof Uint8Array ? data.length : 'no'} bytes` };
  }
  const status = data.subarray(data.length - STATUS_BYTES);
  if (status[0] !== 0) {
    const why = `status ${status[0]},${status[1]}`;
    if (status[1] === ROM_INVALID_COMMAND) return { absent: true, why: why + ': this ROM has no security-info command' };
    return { unreadable: true, why };
  }
  return { payload: data.subarray(0, data.length - STATUS_BYTES) };
}

/**
 * Throws `device.secured` when the chip is locked. Returns how the answer was reached:
 * `'securityInfo'`, `'efuse'`, `'none'` (a family that has neither feature) or `'unknown'`.
 */
export async function checkSecurity(loader, chipFamily, log, { unknownIsLocked = true } = {}) {
  // ESP8266's ROM predates command 0x14, and asking only waits out the five-second timeout —
  // whose shape is precisely the one we must no longer read as "the command is not there".
  if (chipFamily === 'ESP8266') {
    log('this chip family has neither secure boot nor flash encryption');
    return 'none';
  }
  // ⛔ The classic ESP32 never had command 0x14 either, and we know that before we ask. esptool
  // itself only defines `get_security_info` from the ESP32-S2 onwards; the efuses are where the
  // answer lives for this family. Asking anyway used to cost a real device: measured 16.09.2026
  // on an ESP32-D0WDQ6-V3, the reply came back with status 255, which is neither a payload nor
  // the ROM's "invalid command" code (5), so it was read as unreadable and a stock, unlocked
  // Core2 was refused with "this device is locked by its maker". A chip that cannot have the
  // command must not be asked for it: every odd answer it gives is noise we then have to guess at.
  if (chipFamily === 'ESP32') return fromEfuses(loader, chipFamily, log, unknownIsLocked);
  const answer = await askRom(loader);
  log('security info: ' + (answer.why ?? `${answer.payload.length} bytes`));
  // A timeout or a serial error is not an absent command. Refusing here costs a retry; guessing
  // costs somebody their encrypted device, because `factory` would write plaintext over it.
  if (answer.unreadable) fail('device.secured', { reason: 'unreadable' });
  if (answer.absent) return fromEfuses(loader, chipFamily, log, unknownIsLocked);
  const info = answer.payload;
  // The flags word (bytes 0-3) and the flash-encryption count (byte 4) must both be zero, and
  // both shapes of the answer carry them. Anything shorter is not an answer we can read.
  if (info.length < MIN_INFO_BYTES) fail('device.secured', { reason: 'malformed', bytes: info.length });
  const flags = (info[0] | (info[1] << 8) | (info[2] << 16) | (info[3] << 24)) >>> 0;
  if (flags !== 0 || info[4] !== 0) fail('device.secured', { flags: hex(flags), cryptCount: info[4] });
  return 'securityInfo';
}

/**
 * The ROM has no such command. Only the classic ESP32 gets a second chance here: its block-0
 * efuses are the ones esptool reads at `EFUSE_RD_REG_BASE` 0x3FF5A000, and every later family
 * puts something else at that address — which is why `readEfuse` is declared on that class alone
 * in the vendored bundle. ESP8266 never reaches this function; it is answered before the command
 * is sent. So in practice this is: classic ESP32, or `unknown`.
 */
async function fromEfuses(loader, chipFamily, log, unknownIsLocked) {
  if (chipFamily === 'ESP32') {
    const efuses = await esp32Efuses(loader, log);
    if (efuses) {
      const cryptCount = (efuses.crypt >>> CRYPT_COUNT_SHIFT) & CRYPT_COUNT_MASK;
      const encrypted = oddBits(cryptCount);
      const secureBoot = (efuses.boot & SECURE_BOOT_MASK) !== 0;
      if (encrypted || secureBoot) fail('device.secured', { source: 'efuse', cryptCount: hex(cryptCount), secureBoot });
      log(`efuses: secure boot off, flash encryption off (FLASH_CRYPT_CNT ${hex(cryptCount)})`);
      return 'efuse';
    }
  }
  if (unknownIsLocked) fail('device.secured', { reason: 'unsupported' });
  log('the security state of this chip could not be read; nothing is erased or written that this install did not plan');
  return 'unknown';
}
