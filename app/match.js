const lower = (s) => String(s ?? '').toLowerCase();
const includesAll = (haystack, needles) => needles.every((n) => haystack.includes(lower(n)));

/** Returns the first filter a build fails for this hardware, or null when compatible. */
export function whyNot(build, hw) {
  if (lower(build.chipFamily) !== lower(hw.chipFamily)) return 'chipFamily';
  if (build.flashSizeMB !== undefined && build.flashSizeMB !== hw.flashSizeMB) return 'flashSize';
  if (build.usbVendorId !== undefined && hw.usbVendorId !== undefined && build.usbVendorId !== hw.usbVendorId) return 'usb';
  if (build.usbProductId !== undefined && hw.usbProductId !== undefined && build.usbProductId !== hw.usbProductId) return 'usb';
  if (!includesAll(lower(hw.chipDescription), build.chipDescriptionIncludes)) return 'description';
  if (!build.featuresAll.every((n) => (hw.features ?? []).some((f) => lower(f).includes(lower(n))))) return 'features';
  return null;
}

export function compatibleBuilds(builds, hw) {
  return builds.filter((b) => whyNot(b, hw) === null);
}

export function mismatchReasons(builds, hw) {
  return builds.map((b) => ({ boardKey: b.boardKey, reason: whyNot(b, hw) })).filter((r) => r.reason !== null);
}
