import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compatibleBuilds, mismatchReasons } from '../app/match.js';

const part = { path: 'x.bin', url: 'https://h/x.bin', offset: 0 };
const B = (o) => ({ boardKey: 'k', board: 'K', chipFamily: 'ESP32', chipDescriptionIncludes: [], featuresAll: [],
  profile: 'factory', eraseAll: false, parts: [part], ...o });
const HW = (o) => ({ chipFamily: 'ESP32', flashSizeMB: 16, chipDescription: 'ESP32-D0WD-V3 (revision v3.1)', features: ['WiFi', 'BT', 'Dual Core'], ...o });

test('chipFamily is compared case-insensitively and is mandatory', () => {
  assert.equal(compatibleBuilds([B({ chipFamily: 'ESP32' })], HW({ chipFamily: 'esp32' })).length, 1);
  assert.equal(compatibleBuilds([B({ chipFamily: 'ESP32-S3' })], HW()).length, 0);
});

test('flashSizeMB filters only when the build declares it', () => {
  assert.equal(compatibleBuilds([B({})], HW({ flashSizeMB: 4 })).length, 1);
  assert.equal(compatibleBuilds([B({ flashSizeMB: 16 })], HW({ flashSizeMB: 4 })).length, 0);
  assert.equal(compatibleBuilds([B({ flashSizeMB: 16 })], HW({ flashSizeMB: 16 })).length, 1);
});

test('usb ids filter only when both sides know them', () => {
  const b = B({ usbVendorId: 0x1a86, usbProductId: 0x55d4 });
  assert.equal(compatibleBuilds([b], HW()).length, 1);
  assert.equal(compatibleBuilds([b], HW({ usbVendorId: 0x1a86, usbProductId: 0x55d4 })).length, 1);
  assert.equal(compatibleBuilds([b], HW({ usbVendorId: 0x303a, usbProductId: 0x1001 })).length, 0);
});

test('description and feature filters are substring, case-insensitive, all-of', () => {
  assert.equal(compatibleBuilds([B({ chipDescriptionIncludes: ['d0wd'] })], HW()).length, 1);
  assert.equal(compatibleBuilds([B({ chipDescriptionIncludes: ['pico'] })], HW()).length, 0);
  assert.equal(compatibleBuilds([B({ featuresAll: ['wifi', 'bt'] })], HW()).length, 1);
  assert.equal(compatibleBuilds([B({ featuresAll: ['wifi', 'psram'] })], HW()).length, 0);
});

test('mismatchReasons names the first failing filter per build', () => {
  const r = mismatchReasons([B({ boardKey: 'a', chipFamily: 'ESP32-S3' }), B({ boardKey: 'b', flashSizeMB: 4 })], HW());
  assert.deepEqual(r, [{ boardKey: 'a', reason: 'chipFamily' }, { boardKey: 'b', reason: 'flashSize' }]);
});

test('mismatchReasons labels usb, description and feature failures', () => {
  const r = mismatchReasons([
    B({ boardKey: 'u', usbVendorId: 0x1a86, usbProductId: 0x55d4 }),
    B({ boardKey: 'd', chipDescriptionIncludes: ['pico'] }),
    B({ boardKey: 'f', featuresAll: ['psram'] }),
  ], HW({ usbVendorId: 0x303a, usbProductId: 0x1001 }));
  assert.deepEqual(r, [{ boardKey: 'u', reason: 'usb' }, { boardKey: 'd', reason: 'description' }, { boardKey: 'f', reason: 'features' }]);
});
