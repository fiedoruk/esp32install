import { InstallError } from './errors.js';

/** Measured from esptool-js 0.6.1 lib/targets/*.js (2026-09-15). null = not declared by the library. */
export const CHIPS = Object.freeze({
  'ESP8266':   { bootloaderOffset: 0x0,    imageChipId: null, esptoolChip: 'esp8266' },
  'ESP32':     { bootloaderOffset: 0x1000, imageChipId: 0,    esptoolChip: 'esp32' },
  'ESP32-S2':  { bootloaderOffset: 0x1000, imageChipId: 2,    esptoolChip: 'esp32s2' },
  'ESP32-S3':  { bootloaderOffset: 0x0,    imageChipId: 9,    esptoolChip: 'esp32s3' },
  'ESP32-C2':  { bootloaderOffset: 0x0,    imageChipId: 12,   esptoolChip: 'esp32c2' },
  'ESP32-C3':  { bootloaderOffset: 0x0,    imageChipId: 5,    esptoolChip: 'esp32c3' },
  'ESP32-C5':  { bootloaderOffset: 0x2000, imageChipId: 23,   esptoolChip: 'esp32c5' },
  'ESP32-C6':  { bootloaderOffset: 0x0,    imageChipId: 13,   esptoolChip: 'esp32c6' },
  'ESP32-C61': { bootloaderOffset: null,   imageChipId: 20,   esptoolChip: 'esp32c61' },
  'ESP32-H2':  { bootloaderOffset: 0x0,    imageChipId: 16,   esptoolChip: 'esp32h2' },
  'ESP32-P4':  { bootloaderOffset: 0x2000, imageChipId: 18,   esptoolChip: 'esp32p4' },
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
  if (part.sha256 !== undefined && sha256 !== part.sha256) fail('verify.sha256', { path: part.path, expected: part.sha256, actual: sha256 });
  return { sha256 };
}

export function checkLayout(parts, flashBytes, limits = {}) {
  const maxTotal = limits.maxTotal ?? 64 * 1024 * 1024;
  parts.forEach((p, index) => {
    const offsetOk = p !== null && typeof p === 'object' && Number.isSafeInteger(p.offset) && p.offset >= 0;
    const dataOk = offsetOk && p.data instanceof Uint8Array;
    if (!offsetOk || !dataOk) fail('verify.part', { index, offset: p?.offset });
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

/** The part that covers the chip's bootloader offset must start with an ESP image header for this chip. */
export function checkBootImage(parts, chipFamily) {
  const chip = CHIPS[chipFamily];
  if (!chip || chip.bootloaderOffset === null) return;
  const at = chip.bootloaderOffset;
  const holder = parts.find((p) => p.offset <= at && p.offset + p.data.length > at);
  if (!holder) return;
  const rel = at - holder.offset;
  if (holder.data.length < rel + 24 || holder.data[rel] !== ESP_IMAGE_MAGIC) fail('verify.notAnImage', { offset: at });
  if (chip.imageChipId === null) return;
  const imageChipId = holder.data[rel + 12] | (holder.data[rel + 13] << 8);
  if (imageChipId !== chip.imageChipId) {
    const found = Object.entries(CHIPS).find(([, c]) => c.imageChipId === imageChipId)?.[0] ?? String(imageChipId);
    fail('verify.wrongChip', { expected: chipFamily, found });
  }
}

export function esptoolCommand(chipFamily, parts, fileNames) {
  const chip = CHIPS[chipFamily]?.esptoolChip ?? chipFamily.toLowerCase().replace('-', '');
  const pairs = parts.map((p, i) => ({ offset: p.offset, name: fileNames[i] })).sort((a, b) => a.offset - b.offset)
    .map((p) => `0x${p.offset.toString(16)} ${p.name}`).join(' ');
  return `python -m esptool --chip ${chip} --port PORT --baud 460800 write_flash ${pairs}`;
}
