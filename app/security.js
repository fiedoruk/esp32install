/**
 * Is this chip locked by its maker? Both profiles ask before they touch the flash, because
 * writing plaintext to a board with flash encryption or secure boot leaves it unable to start.
 *
 * The answer comes from the ROM's security-info command (0x14) where that exists, and from the
 * efuses where it does not. `unknownIsLocked` is the only difference between the callers: the
 * `preserve` profile writes into a device it promises to keep working and refuses to guess, while
 * a `factory` install may go ahead on a chip that cannot say, because that is every ordinary
 * ESP8266 and every classic ESP32 whose efuses could not be read.
 */
import { InstallError } from './errors.js';

const COMMAND = 0x14;
const INFO_BYTES = 20;
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
 * Throws `device.secured` when the chip is locked. Returns how the answer was reached:
 * `'securityInfo'`, `'efuse'`, `'none'` (a family that has neither feature) or `'unknown'`.
 */
export async function checkSecurity(loader, chipFamily, log, { unknownIsLocked = true } = {}) {
  let info;
  try {
    info = await loader.checkCommand('security info', COMMAND, new Uint8Array(0), 0, INFO_BYTES, INFO_TIMEOUT);
  } catch (err) {
    // The command is ESP32-S3 and newer; on anything older this is what "not supported" looks like.
    log('security info: ' + (err?.message ?? err));
    return fromEfuses(loader, chipFamily, log, unknownIsLocked);
  }
  // The flags word (bytes 0-3) and the flash-encryption count (byte 4) must both be zero.
  if (!(info instanceof Uint8Array) || info.length !== INFO_BYTES) fail('device.secured', { reason: 'malformed' });
  const flags = (info[0] | (info[1] << 8) | (info[2] << 16) | (info[3] << 24)) >>> 0;
  if (flags !== 0 || info[4] !== 0) fail('device.secured', { flags: hex(flags), cryptCount: info[4] });
  return 'securityInfo';
}

async function fromEfuses(loader, chipFamily, log, unknownIsLocked) {
  if (chipFamily === 'ESP8266') {
    log('this chip family has neither secure boot nor flash encryption');
    return 'none';
  }
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
