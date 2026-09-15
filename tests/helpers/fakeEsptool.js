/** Minimal stand-in for esptool-js 0.6.1 used by engine tests. Records calls; never touches hardware. */
export function makeFakeEsptool({
  chipName = 'ESP32',
  flashId = 0x001840c8,
  md5Mismatch = false,
  failConnect = false,
  failErase = false,
  features = ['WiFi', 'BT'],
} = {}) {
  const calls = [];
  class Transport {
    constructor(port) { this.port = port; calls.push(['transport']); }
    setDeviceLostCallback(fn) { this.lost = fn; }
    async disconnect() { calls.push(['disconnect']); }
  }
  class ESPLoader {
    constructor(opts) {
      this.opts = opts;
      this.DETECTED_FLASH_SIZES = { 0x14: '1MB', 0x15: '2MB', 0x16: '4MB', 0x17: '8MB', 0x18: '16MB' };
    }
    async main() {
      if (failConnect) throw new Error('Failed to connect with the device');
      this.chip = {
        CHIP_NAME: chipName,
        BOOTLOADER_FLASH_OFFSET: chipName === 'ESP32' ? 0x1000 : 0,
        IMAGE_CHIP_ID: chipName === 'ESP32' ? 0 : 9,
        getChipDescription: async () => chipName + '-D0WD-V3 (revision v3.1)',
        getChipFeatures: async () => features,
        readMac: async () => 'aa:bb:cc:dd:ee:ff',
      };
      calls.push(['main']);
      return 'desc';
    }
    async readFlashId() { calls.push(['readFlashId']); return flashId; }
    async eraseFlash() {
      calls.push(['eraseFlash']);
      if (failErase) throw new Error('Timed out waiting for packet header');
    }
    async writeFlash(o) {
      calls.push(['writeFlash', o.fileArray.map((f) => [f.address, f.data.length]), o.eraseAll, o.compress]);
      for (let i = 0; i < o.fileArray.length; i++) {
        o.calculateMD5Hash?.(o.fileArray[i].data);
        o.reportProgress?.(i, o.fileArray[i].data.length, o.fileArray[i].data.length);
        // Exact message esptool-js 0.6.1 throws (lib/esploader.js line 1453).
        if (md5Mismatch) throw new Error('MD5 of file does not match data in flash!');
      }
    }
    async after(mode) { calls.push(['after', mode]); }
  }
  return { ESPLoader, Transport, calls };
}
