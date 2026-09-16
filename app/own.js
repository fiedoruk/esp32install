/**
 * The own-file path's model, with no DOM in it: what each file says about itself, where a build
 * tool would have put it, and whether a set of files can go on one device together. The page asks
 * these questions before the button turns on; the engine asks the same ones again, against the
 * real chip, before anything is written. Nothing here is a decision: every default stays editable.
 */
import { InstallError } from './errors.js';
import { CHIPS, inspectImage, checkLayout, checkBootImage, checkImageParts } from './verify.js';

/** A PlatformIO or Arduino build is three or four files; six leaves room for a data image or two. */
export const MAX_PARTS = 6;
export const PARTITION_TABLE_OFFSET = 0x8000;
export const OTA_DATA_OFFSET = 0xe000;
export const APP_OFFSET = 0x10000;
// The largest flash a manifest may declare (flashSizeMB up to 1024). The real size is read from the
// chip after connecting and the layout is checked again there; before that only overlap and the
// total size can be known.
const LARGEST_FLASH = 1024 * 1024 * 1024;
const PARTITION_MAGIC = [0xaa, 0x50];
const ESP_IMAGE_MAGIC = 0xe9;
const ESP_IMAGE_HEADER_BYTES = 24;

/**
 * What one file says about itself and where a build tool would have put it. `kind` is one of
 * `whole` (a merged image: bootloader at the family's offset, partition table at 0x8000), `table`
 * (a partition table, by its magic), `otadata` (`boot_app0.bin`, by name), `boot` (an image named
 * bootloader), `app` (any other image) or `data` (none of those). `offset` is the default address,
 * or null when the file gives no hint; `chipFamily` is what the image header says, or null. A
 * bootloader's offset depends on the family, so `chipHint` stands in when the header names none.
 */
export function describePart(name, bytes, chipHint = null) {
  const { chipFamily, whole } = inspectImage(bytes);
  const image = bytes instanceof Uint8Array && bytes.length >= ESP_IMAGE_HEADER_BYTES && bytes[0] === ESP_IMAGE_MAGIC;
  const table = bytes instanceof Uint8Array && bytes.length >= 2 && bytes[0] === PARTITION_MAGIC[0] && bytes[1] === PARTITION_MAGIC[1];
  const lower = String(name ?? '').toLowerCase();
  if (whole) return { chipFamily, kind: 'whole', offset: 0 };
  if (table) return { chipFamily: null, kind: 'table', offset: PARTITION_TABLE_OFFSET };
  if (/boot_app0/.test(lower)) return { chipFamily: null, kind: 'otadata', offset: OTA_DATA_OFFSET };
  if (image && /bootloader/.test(lower)) {
    const family = chipFamily ?? chipHint;
    return { chipFamily, kind: 'boot', offset: CHIPS[family]?.bootloaderOffset ?? null };
  }
  if (image) return { chipFamily, kind: 'app', offset: APP_OFFSET };
  return { chipFamily: null, kind: 'data', offset: null };
}

/** The family the image headers agree on, or null when none of the files names one. */
export function headerFamily(parts) {
  return parts.map((p) => p.chipFamily).find(Boolean) ?? null;
}

/**
 * Why this set of files cannot go on `chipFamily` together, as the InstallError the engine would
 * throw, or null. `parts` are `{ name, offset, bytes }`. The same three checks the engine runs
 * after connecting: no overlap and nothing absurdly large, whatever covers the bootloader offset
 * is an image for this family, and every part that looks like an image is for this family too.
 * `verify.wrongChip` gets the offending file's `name` added, so the page can point at it.
 */
export function ownProblem(parts, chipFamily) {
  const laid = parts.map((p) => ({ path: p.name, offset: p.offset, data: p.bytes }));
  try {
    checkLayout(laid, LARGEST_FLASH);
    checkBootImage(laid, chipFamily);
    checkImageParts(laid, chipFamily);
  } catch (e) {
    const error = e instanceof InstallError ? e : new InstallError('engine.unexpected', { detail: String(e?.message ?? e) }, e);
    if (error.code === 'verify.wrongChip' && error.params.name === undefined) {
      const at = error.params.offset ?? CHIPS[chipFamily]?.bootloaderOffset ?? 0;
      const holder = laid.find((p) => p.offset <= at && p.offset + p.data.length > at);
      error.params = { ...error.params, name: holder?.path ?? '' };
    }
    return error;
  }
  return null;
}
