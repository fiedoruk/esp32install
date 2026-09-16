import { InstallError } from './errors.js';
import { md5Hex } from './md5.js';

/** Measured from esptool-js 0.6.1 lib/targets/*.js (2026-09-15). null = not declared by the library. */
const row = (bootloaderOffset, imageChipId, esptoolChip) => Object.freeze({ bootloaderOffset, imageChipId, esptoolChip });
export const CHIPS = Object.freeze({
  'ESP8266':   row(0x0, null, 'esp8266'),
  'ESP32':     row(0x1000, 0, 'esp32'),
  'ESP32-S2':  row(0x1000, 2, 'esp32s2'),
  'ESP32-S3':  row(0x0, 9, 'esp32s3'),
  'ESP32-C2':  row(0x0, 12, 'esp32c2'),
  'ESP32-C3':  row(0x0, 5, 'esp32c3'),
  'ESP32-C5':  row(0x2000, 23, 'esp32c5'),
  'ESP32-C6':  row(0x0, 13, 'esp32c6'),
  'ESP32-C61': row(null, 20, 'esp32c61'),
  'ESP32-H2':  row(0x0, 16, 'esp32h2'),
  'ESP32-P4':  row(0x2000, 18, 'esp32p4'),
});

const ESP_IMAGE_MAGIC = 0xe9;
const fail = (code, params) => { throw new InstallError(code, params); };

export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function checkFetchedPart(part, data, limits = {}) {
  const maxPart = limits.maxPart ?? 32 * 1024 * 1024;
  if (!(data instanceof Uint8Array) || data.length === 0) fail('verify.empty', { path: part.path });
  if (data.length > maxPart) fail('verify.tooLarge', { path: part.path, bytes: data.length, max: maxPart });
  if (part.size !== undefined && data.length !== part.size) fail('verify.size', { path: part.path, bytes: data.length, expected: part.size });
  const sha256 = await sha256Hex(data);
  if (part.sha256 !== undefined && sha256 !== String(part.sha256).toLowerCase()) fail('verify.sha256', { path: part.path, expected: part.sha256, actual: sha256 });
  // The release's MD5, where it declares one. The device can answer for this number and for no
  // other, so it is worth catching a manifest that disagrees with its own file here, before
  // anything is opened, rather than after the write when the only honest report is "keep your copy".
  const md5 = part.md5 === undefined ? undefined : md5Hex(data);
  if (part.md5 !== undefined && md5 !== String(part.md5).toLowerCase()) fail('verify.md5', { path: part.path, expected: part.md5, actual: md5 });
  return { sha256, md5 };
}

export function checkLayout(parts, flashBytes, limits = {}) {
  if (!Number.isSafeInteger(flashBytes) || flashBytes <= 0) fail('verify.flashSize', { flashBytes: String(flashBytes) });
  const maxTotal = limits.maxTotal ?? 64 * 1024 * 1024;
  parts.forEach((p, index) => {
    const offsetOk = p !== null && typeof p === 'object' && Number.isSafeInteger(p.offset) && p.offset >= 0;
    const dataOk = offsetOk && p.data instanceof Uint8Array;
    if (!offsetOk || !dataOk) fail('verify.part', { index, offset: p?.offset });
    if (p.data.length === 0) fail('verify.empty', { offset: p.offset });
  });
  let total = 0;
  const sorted = [...parts].sort((a, b) => a.offset - b.offset);
  for (const p of sorted) {
    total += p.data.length;
    if (p.offset + p.data.length > flashBytes) fail('verify.beyondFlash', { offset: p.offset, end: p.offset + p.data.length, flashBytes });
  }
  if (total > maxTotal) fail('verify.totalTooLarge', { bytes: total, max: maxTotal });
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    if (prev.offset + prev.data.length > sorted[i].offset) fail('verify.overlap', { a: prev.offset, b: sorted[i].offset });
  }
}

const ESP_IMAGE_HEADER_BYTES = 24;
const familyOfImageChipId = (id) => Object.entries(CHIPS).find(([, c]) => c.imageChipId === id)?.[0] ?? String(id);

/** The part that covers the chip's bootloader offset must start with an ESP image header for this chip. */
export function checkBootImage(parts, chipFamily) {
  const chip = CHIPS[chipFamily];
  if (!chip) fail('verify.chipUnknown', { chipFamily });
  if (chip.bootloaderOffset === null) return;
  const at = chip.bootloaderOffset;
  const holder = parts.find((p) => p.offset <= at && p.offset + p.data.length > at);
  if (!holder) return;
  const rel = at - holder.offset;
  if (holder.data.length < rel + ESP_IMAGE_HEADER_BYTES || holder.data[rel] !== ESP_IMAGE_MAGIC) fail('verify.notAnImage', { offset: at });
  if (chip.imageChipId === null) return;
  const imageChipId = holder.data[rel + 12] | (holder.data[rel + 13] << 8);
  if (imageChipId !== chip.imageChipId) fail('verify.wrongChip', { expected: chipFamily, found: familyOfImageChipId(imageChipId) });
}

/**
 * Every part that looks like an ESP image (at least a header long and `0xE9` first) must carry
 * this family's image chip id, wherever it is written. An application at `0x20000` never covers
 * the bootloader offset, so without this an app built for another chip would pass `checkBootImage`.
 * A data part that happens to start with `0xE9` is refused too; that is the price of failing closed.
 * Families whose images carry no chip id (ESP8266) are not checked.
 */
export function checkImageParts(parts, chipFamily) {
  const chip = CHIPS[chipFamily];
  if (!chip) fail('verify.chipUnknown', { chipFamily });
  if (chip.imageChipId === null) return;
  for (const p of parts) {
    if (p.data.length < ESP_IMAGE_HEADER_BYTES || p.data[0] !== ESP_IMAGE_MAGIC) continue;
    const imageChipId = p.data[12] | (p.data[13] << 8);
    if (imageChipId !== chip.imageChipId) fail('verify.wrongChip', { expected: chipFamily, found: familyOfImageChipId(imageChipId), offset: p.offset });
  }
}

const PARTITION_TABLE_OFFSET = 0x8000;
const PARTITION_MAGIC = [0xaa, 0x50];
const HEADER_OFFSETS = [0x0, 0x1000, 0x2000]; // every bootloader offset the chip table declares
const allFF = (b, from, to) => { for (let i = from; i < to; i++) if (b[i] !== 0xff) return false; return true; };
const familyOrNull = (id) => Object.entries(CHIPS).find(([, c]) => c.imageChipId === id)?.[0] ?? null;

/**
 * What one file says about itself, for the own-file path. A merged image starts with the
 * bootloader at the family's offset (0x0, 0x1000 or 0x2000), padded with 0xff before it, and
 * carries a partition table at 0x8000; an application image starts with its own header at byte 0
 * and has neither. `chipFamily` is null when no header is found or its id names no known family
 * (ESP8266 images carry no id and are never identified). `whole` is true only for a merged image,
 * and the caller shows it as a default, never as a decision.
 */
export function inspectImage(bytes) {
  const out = { headerOffset: null, chipFamily: null, whole: false };
  if (!(bytes instanceof Uint8Array)) return out;
  for (const at of HEADER_OFFSETS) {
    if (bytes.length < at + ESP_IMAGE_HEADER_BYTES || bytes[at] !== ESP_IMAGE_MAGIC) continue;
    if (at > 0 && !allFF(bytes, 0, at)) continue;
    out.headerOffset = at;
    out.chipFamily = familyOrNull(bytes[at + 12] | (bytes[at + 13] << 8));
    const table = bytes.length > PARTITION_TABLE_OFFSET + 1
      && bytes[PARTITION_TABLE_OFFSET] === PARTITION_MAGIC[0] && bytes[PARTITION_TABLE_OFFSET + 1] === PARTITION_MAGIC[1];
    out.whole = table && (out.chipFamily === null ? at > 0 : CHIPS[out.chipFamily].bootloaderOffset === at);
    break;
  }
  return out;
}

export function esptoolCommand(chipFamily, parts, fileNames) {
  if (fileNames.length !== parts.length) fail('verify.part', { index: Math.min(parts.length, fileNames.length) });
  const chip = CHIPS[chipFamily]?.esptoolChip ?? chipFamily.toLowerCase().replace('-', '');
  const pairs = parts.map((p, i) => ({ offset: p.offset, name: fileNames[i] })).sort((a, b) => a.offset - b.offset)
    .map((p) => `0x${p.offset.toString(16)} ${p.name}`).join(' ');
  return `python -m esptool --chip ${chip} --port PORT --baud 460800 write_flash ${pairs}`;
}
