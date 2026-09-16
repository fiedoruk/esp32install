/**
 * The partition-table reader, against bytes built the way ESP-IDF writes them. No device is
 * needed for any of this: the parser is a pure function over a page of 32-byte entries, and the
 * reader is that function with a `readFlash` in front of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_BYTES, TABLE_BYTES, parsePartitionTable, settingsPartition, entryLine, readPartitionTable, layoutParams,
} from '../app/partitions.js';
import { PARTITION_TABLE_OFFSET } from '../app/own.js';
import { entry, table, DEFAULT_ENTRIES as DEFAULT } from './helpers/partitionTable.js';

test('every field of every entry comes back, in the order the table lists them', () => {
  const entries = parsePartitionTable(table(DEFAULT));
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], { type: 1, subtype: 2, offset: 0x9000, size: 0x6000, label: 'nvs' });
  assert.deepEqual(entries[2], { type: 0, subtype: 0x10, offset: 0x10000, size: 0x1e0000, label: 'app0' });
  assert.deepEqual(entries.map((e) => e.label), ['nvs', 'phy_init', 'app0', 'app1']);
});

test('parsing stops at the first entry that is not the magic: the 0xff padding', () => {
  // A fifth entry sits after the padding; it must never be reached, or a blank page would
  // hand back whatever an old table left further down.
  const page = table(DEFAULT);
  page.set(entry({ type: 1, subtype: 2, offset: 0x330000, size: 0x1000, label: 'ghost' }), 5 * ENTRY_BYTES);
  const entries = parsePartitionTable(page);
  assert.equal(entries.length, 4);
  assert.ok(!entries.some((e) => e.label === 'ghost'));
});

test("parsing stops at ESP-IDF's own MD5 entry, which carries 0xEB 0xEB instead", () => {
  const md5 = entry({ type: 0, subtype: 0, offset: 0, size: 0, magic: [0xeb, 0xeb] });
  assert.equal(parsePartitionTable(table([...DEFAULT, md5])).length, 4);
});

test('a page of 0xff, a short buffer and a non-buffer are all "no entries", never an error', () => {
  assert.deepEqual(parsePartitionTable(new Uint8Array(TABLE_BYTES).fill(0xff)), []);
  assert.deepEqual(parsePartitionTable(new Uint8Array(0)), []);
  assert.deepEqual(parsePartitionTable(new Uint8Array([0xaa, 0x50, 1, 2])), [], 'half an entry is no entry');
  assert.deepEqual(parsePartitionTable(null), []);
  assert.deepEqual(parsePartitionTable('0xaa50'), []);
});

test('a label is cut at its NUL padding and carries nothing unprintable', () => {
  const e = entry({ type: 1, subtype: 2, offset: 0x9000, size: 0x1000, label: 'nvs' });
  e[12 + 3] = 0; e[12 + 4] = 0x41; // an 'A' behind the terminator is not part of the label
  assert.equal(parsePartitionTable(table([e]))[0].label, 'nvs');
  const junk = entry({ type: 1, subtype: 2, offset: 0x9000, size: 0x1000 });
  junk.set([0x01, 0x6e, 0x7f, 0x76, 0x73], 12); // control bytes around "nvs"
  assert.equal(parsePartitionTable(table([junk]))[0].label, 'nvs');
});

test('a subarray of a larger buffer is parsed from its own start', () => {
  const big = new Uint8Array(0x10000).fill(0);
  big.set(table(DEFAULT), 0x8000);
  assert.equal(parsePartitionTable(big.subarray(0x8000, 0x8000 + TABLE_BYTES)).length, 4);
});

test('the settings partition is data/NVS, and no other data partition passes for it', () => {
  assert.deepEqual(settingsPartition(parsePartitionTable(table(DEFAULT))).offset, 0x9000);
  const noNvs = [
    entry({ type: 1, subtype: 0, offset: 0x9000, size: 0x1000, label: 'phy_init' }),
    entry({ type: 1, subtype: 1, offset: 0xa000, size: 0x2000, label: 'otadata' }),
    entry({ type: 0, subtype: 2, offset: 0x10000, size: 0x1000, label: 'app' }), // app/2, not data/2
  ];
  assert.equal(settingsPartition(parsePartitionTable(table(noNvs))), null);
  assert.equal(settingsPartition([]), null);
});

test('entryLine says label, kind and span in hex, and names an unlabelled entry as such', () => {
  const entries = parsePartitionTable(table(DEFAULT));
  assert.equal(entryLine(entries[0]), 'nvs 1/2 0x9000+0x6000');
  assert.equal(entryLine({ type: 1, subtype: 2, offset: 0x9000, size: 0x1000, label: '' }), '(unlabelled) 1/2 0x9000+0x1000');
});

test('readPartitionTable reads the table page from 0x8000 and returns what it found', async () => {
  const reads = [];
  const read = async (_loader, offset, size) => { reads.push([offset, size]); return table(DEFAULT); };
  const layout = await readPartitionTable({}, { read });
  assert.deepEqual(reads, [[PARTITION_TABLE_OFFSET, TABLE_BYTES]]);
  assert.equal(PARTITION_TABLE_OFFSET, 0x8000);
  assert.equal(layout.offset, 0x8000);
  assert.equal(layout.entries.length, 4);
  assert.equal(layout.settings.offset, 0x9000);
  assert.equal(layout.settings, layout.entries[0], 'the settings entry is one of the entries, not a copy');
});

test('readPartitionTable on a blank page returns no entries and no settings, and does not throw', async () => {
  const layout = await readPartitionTable({}, { read: async () => new Uint8Array(TABLE_BYTES).fill(0xff) });
  assert.deepEqual(layout.entries, []);
  assert.equal(layout.settings, null);
});

test('a read that throws is passed on, for the caller to log and carry on from', async () => {
  await assert.rejects(readPartitionTable({}, { read: async () => { throw new Error('timed out'); } }), /timed out/);
});

test('layoutParams says where the settings are, or that the table could not be read, and nothing else', async () => {
  const good = await readPartitionTable({}, { read: async () => table(DEFAULT) });
  assert.deepEqual(layoutParams(good), { settingsOffset: 0x9000, settingsSize: 0x6000 });
  assert.deepEqual(layoutParams(null), { layout: 'unreadable' });
  assert.deepEqual(layoutParams({ entries: [], settings: null }), { layout: 'unreadable' });
  const noNvs = await readPartitionTable({}, { read: async () => table([entry({ type: 0, subtype: 0x10, offset: 0x10000, size: 0x1000, label: 'app0' })]) });
  assert.deepEqual(layoutParams(noNvs), {}, 'a table without an NVS entry adds nothing rather than inventing a reason');
});
