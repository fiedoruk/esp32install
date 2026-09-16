/**
 * Seconds left, from throughput so far: the same estimate for writing and for the backup reads.
 * Undefined until a second has passed, because the first chunk says nothing about the rate.
 */
export function etaSeconds(startedAt, done, total, now = Date.now) {
  const elapsed = (now() - startedAt) / 1000;
  return done > 0 && elapsed > 1 ? Math.round(((total - done) * elapsed) / done) : undefined;
}

/** Espressif's own USB vendor id: the chip's built-in USB-JTAG/OTG port, no bridge in between. */
const ESPRESSIF_VENDOR_ID = 0x303a;

/**
 * Whole minutes a copy of this device's flash takes, for the checkbox on the first screen.
 * The assumption, measured on the fixture devices and rounded down to be honest rather than
 * flattering: a whole-flash read runs at roughly 1 MB per minute through a UART bridge (CP210x,
 * CH9102 and the like, at 460800 baud) and roughly 8 MB per minute through the chip's own USB
 * port. Nothing is known before the device has been read, so the caller falls back to words then.
 */
export function backupMinutes(hw) {
  const mb = Number(hw?.flashSizeMB);
  if (!Number.isFinite(mb) || mb <= 0) return null;
  const perMinute = hw?.usbVendorId === ESPRESSIF_VENDOR_ID ? 8 : 1;
  return Math.max(1, Math.ceil(mb / perMinute));
}
