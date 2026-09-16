/**
 * The device's own partition table, read instead of assumed.
 *
 * This module is diagnostics and nothing else. No decision in this installer is made from what
 * it returns: `preserve` still refuses a device whose layout does not match the checksums the
 * release pinned, and `factory` still writes exactly what the release says. All this adds is the
 * ability to tell the person what their device actually has — in the technical layer, and on the
 * stopped screen, where an offset on its own said almost nothing.
 *
 * Format (ESP-IDF, `esp_partition_info_t`): a page of 32-byte entries at `PARTITION_TABLE_OFFSET`,
 * each beginning with the magic `0xAA 0x50` (little-endian `0x50AA`), then type, subtype, a
 * 32-bit offset, a 32-bit size, a 16-byte label and four flag bytes. The list ends at the first
 * entry that does not carry that magic: the `0xff` of an unwritten page, or the `0xEB 0xEB` of
 * the optional MD5 entry ESP-IDF appends after the last real one.
 */
import { PARTITION_TABLE_OFFSET } from './own.js';
import { readRange } from './backup.js';

export const ENTRY_BYTES = 32;
/** What ESP-IDF reserves for the table: 0xC00 bytes, room for 95 entries and the MD5 entry. */
export const TABLE_BYTES = 0xc00;
const MAGIC = [0xaa, 0x50];
const LABEL_AT = 12;
const LABEL_BYTES = 16;
/** A data partition of subtype NVS is where ESP-IDF keeps Wi-Fi credentials and settings. */
const TYPE_DATA = 1;
const SUBTYPE_NVS = 2;

/** The label as written, without its NUL padding and without anything unprintable. */
function labelOf(bytes, at) {
  let s = '';
  for (let i = at + LABEL_AT; i < at + LABEL_AT + LABEL_BYTES; i++) {
    const b = bytes[i];
    if (b === 0) break;
    if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
  }
  return s;
}

/**
 * The entries `bytes` holds, in the order the table lists them. Pure: no device, no loader, so
 * a fixture of real bytes is the whole of what it takes to test it. An empty array means the
 * page carried no entry at all — an unwritten table, a device whose layout lives elsewhere, or
 * bytes that never were a table. That is "unreadable", and never an error that stops anything.
 */
export function parsePartitionTable(bytes) {
  const out = [];
  if (!(bytes instanceof Uint8Array)) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + ENTRY_BYTES <= bytes.length; at += ENTRY_BYTES) {
    if (bytes[at] !== MAGIC[0] || bytes[at + 1] !== MAGIC[1]) break;
    out.push({
      type: bytes[at + 2],
      subtype: bytes[at + 3],
      offset: view.getUint32(at + 4, true),
      size: view.getUint32(at + 8, true),
      label: labelOf(bytes, at),
    });
  }
  return out;
}

/** The entry ESP-IDF keeps settings in (data, NVS), or null when the table has none. */
export function settingsPartition(entries) {
  return entries.find((e) => e.type === TYPE_DATA && e.subtype === SUBTYPE_NVS) ?? null;
}

/** One entry for the technical log: label, kind, and the span it occupies, all in hex. */
export function entryLine(e) {
  return `${e.label || '(unlabelled)'} ${e.type}/${e.subtype} 0x${e.offset.toString(16)}+0x${e.size.toString(16)}`;
}

/**
 * Reads the table page off the device and parses it. Throws whatever the read throws — the
 * caller catches it, logs it and carries on, because nothing here is allowed to stop an install.
 */
export async function readPartitionTable(loader, { offset = PARTITION_TABLE_OFFSET, size = TABLE_BYTES, read = readRange } = {}) {
  const entries = parsePartitionTable(await read(loader, offset, size));
  return { offset, entries, settings: settingsPartition(entries) };
}

/**
 * What a `device.layout` stop may honestly add about the device itself: where its settings are,
 * or that the table could not be read. Never a reason and never a guess — a table without an
 * NVS entry adds nothing rather than inventing something, and the refusal reads as it always did.
 */
export function layoutParams(layout) {
  if (!layout || layout.entries.length === 0) return { layout: 'unreadable' };
  const s = layout.settings;
  return s ? { settingsOffset: s.offset, settingsSize: s.size } : {};
}
