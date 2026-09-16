import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etaSeconds, backupMinutes } from '../app/progress.js';

test('etaSeconds: nothing until a second has passed and something is done, then the remainder at the rate so far', () => {
  let t = 1000;
  const now = () => t;
  assert.equal(etaSeconds(1000, 0, 100, now), undefined);
  t = 1500;
  assert.equal(etaSeconds(1000, 10, 100, now), undefined, 'half a second says nothing');
  t = 3000;
  assert.equal(etaSeconds(1000, 20, 100, now), 8, '20 in 2 s leaves 80 at 10/s');
  assert.equal(etaSeconds(1000, 100, 100, now), 0);
});

test('backupMinutes: about 1 MB a minute through a UART bridge, about 8 through the chip\'s own USB port, two reads per copy, whole minutes, never zero', () => {
  assert.equal(backupMinutes({ flashSizeMB: 16, usbVendorId: 0x1a86 }), 32, 'CH9102 bridge, 16 MB read twice');
  assert.equal(backupMinutes({ flashSizeMB: 16, usbVendorId: 0x10c4 }), 32, 'CP210x bridge');
  assert.equal(backupMinutes({ flashSizeMB: 16 }), 32, 'no vendor id reported: the slow assumption');
  assert.equal(backupMinutes({ flashSizeMB: 16, usbVendorId: 0x303a }), 4, 'Espressif USB-JTAG');
  assert.equal(backupMinutes({ flashSizeMB: 4, usbVendorId: 0x303a }), 1);
  assert.equal(backupMinutes({ flashSizeMB: 4 }), 8);
  assert.equal(backupMinutes({ flashSizeMB: 1 }), 2);
});

test('backupMinutes: null when nothing is known, so the page falls back to words', () => {
  assert.equal(backupMinutes(null), null);
  assert.equal(backupMinutes({}), null);
  assert.equal(backupMinutes({ flashSizeMB: 0 }), null);
  assert.equal(backupMinutes({ flashSizeMB: 'x' }), null);
});
