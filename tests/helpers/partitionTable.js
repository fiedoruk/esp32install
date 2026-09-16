/**
 * Partition-table fixtures: bytes laid out exactly as ESP-IDF's `esp_partition_info_t` is, so a
 * test can hand the reader a real table without a device. Shared by the parser's own tests and
 * by the engine tests that need a device with a layout on it.
 */
export const ENTRY_BYTES = 32;
export const TABLE_BYTES = 0xc00;

/** One entry: magic, type, subtype, offset, size, a 16-byte label and four flag bytes. */
export function entry({ type, subtype, offset, size, label = '', magic = [0xaa, 0x50], flags = 0 }) {
  const e = new Uint8Array(ENTRY_BYTES);
  const view = new DataView(e.buffer);
  e[0] = magic[0]; e[1] = magic[1]; e[2] = type; e[3] = subtype;
  view.setUint32(4, offset, true);
  view.setUint32(8, size, true);
  for (let i = 0; i < label.length && i < 16; i++) e[12 + i] = label.charCodeAt(i);
  view.setUint32(28, flags, true);
  return e;
}

/** A whole table page: the entries given, then the 0xff of a page nothing else was written to. */
export function table(entries, size = TABLE_BYTES) {
  const out = new Uint8Array(size).fill(0xff);
  entries.forEach((e, i) => out.set(e, i * ENTRY_BYTES));
  return out;
}

/** What an ESP-IDF default build writes: NVS at 0x9000, then phy_init and the two app slots. */
export const DEFAULT_ENTRIES = [
  entry({ type: 1, subtype: 2, offset: 0x9000, size: 0x6000, label: 'nvs' }),
  entry({ type: 1, subtype: 0, offset: 0xf000, size: 0x1000, label: 'phy_init' }),
  entry({ type: 0, subtype: 0x10, offset: 0x10000, size: 0x1e0000, label: 'app0' }),
  entry({ type: 0, subtype: 0x11, offset: 0x1f0000, size: 0x1e0000, label: 'app1' }),
];
