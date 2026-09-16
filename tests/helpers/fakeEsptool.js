/** Minimal stand-in for esptool-js 0.6.1 used by engine tests. Records calls; never touches hardware. */
import { md5Hex } from '../../app/md5.js';

export function makeFakeEsptool({
  chipName = 'ESP32',
  flashId = 0x001840c8,
  md5Mismatch = false,
  failConnect = false,
  failErase = false,
  failReset = false,
  features = ['WiFi', 'BT'],
  // Preserve-profile knobs. `flashImage` seeds the simulated flash (copied, never shared).
  flashImage = null,
  flashBytes = 16 * 1024 * 1024,
  mac = 'aa:bb:cc:dd:ee:ff',
  macSequence = null,       // e.g. ['a', 'a', 'b']: readMac answers in turn, then repeats the last
  securityInfo = null,      // payload the ROM answers command 0x14 with: 12 bytes on an ESP32-S2, 20 on an ESP32-S3
  securityRejects = false,  // chip that does not know the security-info command
  securityFails = null,     // message: the command throws instead of answering (a timeout, a serial error)
  securityStatus = null,    // [status, error] bytes to answer with instead of a payload. The shape a real
                            // ESP32-D0WDQ6-V3 gave on 16.09.2026 was [255, 0]: not a payload, and not the
                            // ROM's invalid-command code (5) either.
  efuse = null,             // { 0: word0, 6: word6 }: block-0 efuses a classic ESP32 would report
  tamperRead = null,        // (addr, n, index, data) => void — may mutate the bytes returned by readFlash
  corruptAt = null,         // flash address bumped after every writeFlash (models a bad write)
} = {}) {
  const calls = [];
  const transports = [];
  const loaders = [];   // every ESPLoader made, so a test can read the baud rate the page asked for
  const writes = [];    // every writeFlash options object, whole: flashMode, flashFreq, flashSize
  const flash = new Uint8Array(flashBytes).fill(0xff);
  if (flashImage) flash.set(flashImage.subarray(0, flashBytes), 0);
  let macCalls = 0, readCalls = 0;
  class Transport {
    constructor(...args) { this.args = args; this.port = args[0]; transports.push(this); calls.push(['transport']); }
    setDeviceLostCallback(fn) { this.lost = fn; }
    // The reset line, so a test can see whether the device was actually pulsed or only released.
    async setRTS(level) { calls.push(['setRTS', level]); if (failReset) throw new Error('Failed to reset device'); }
    async disconnect() { calls.push(['disconnect']); }
  }
  class ESPLoader {
    constructor(opts) {
      this.opts = opts;
      loaders.push(this);
      this.flash = flash;
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
        readMac: async () => {
          calls.push(['readMac']);
          if (!macSequence) return mac;
          return macSequence[Math.min(macCalls++, macSequence.length - 1)];
        },
        // Only a chip whose efuses were seeded has this method, as in esptool-js, where it is
        // declared on ESP32ROM and reads that family's own EFUSE_RD_REG_BASE.
        ...(efuse ? { readEfuse: async (_loader, word) => { calls.push(['readEfuse', word]); return efuse[word] ?? 0; } } : {}),
      };
      calls.push(['main']);
      return 'desc';
    }
    async readFlashId() { calls.push(['readFlashId']); return flashId; }
    /**
     * esptool-js `command(op, data, chk, waitResponse, timeout)` → `[value, data]`, where `data`
     * is the payload with the two status bytes on the end. The length of that payload is the
     * whole of the security gate's old blind spot, so it is modelled here: an ESP32-S2 answers
     * command 0x14 with 12 bytes and an ESP32-S3 with 20, and a ROM without the command answers
     * with the error status alone.
     */
    async command(op, data, chk, waitResponse = true, timeout) {
      calls.push(['command', op, timeout]);
      if (op !== 0x14) throw new Error(`fake esptool: no command 0x${op.toString(16)}`);
      if (securityFails) throw new Error(securityFails);
      if (securityRejects) return [0, Uint8Array.from([1, 5])]; // ROM_INVALID_RECV_MSG
      if (securityStatus) return [0, Uint8Array.from(securityStatus)];
      const payload = securityInfo ?? new Uint8Array(20);
      const out = new Uint8Array(payload.length + 2);
      out.set(payload, 0);
      return [0, out];
    }
    /**
     * The vendored helper, rule for rule (esptool-js 0.6.1 `checkCommand`), including the length
     * test that makes it throw on a reply shorter than `resplen + 2` and the status bytes it
     * reads at a fixed place. Nothing in `app/` calls it any more — this is the model that says
     * why, and a test drives it directly so the reason cannot quietly stop being true.
     */
    async checkCommand(desc, op, data, chk, resplen = 0, timeout) {
      const [value, out] = await this.command(op, data, chk, true, timeout);
      if (out && out.length < resplen + 2) {
        const s = out.slice(0, 2);
        throw new Error(s[0] !== 0
          ? `Failed to ${desc} failed with status ${s}`
          : `Failed to ${desc}.\n Only got ${out.length} bytes of data.`);
      }
      const status = out.slice(resplen, resplen + 2);
      if (status[0] !== 0) throw new Error(`Failed to ${desc} failed with status ${status}`);
      return resplen > 0 ? out.slice(0, resplen) : value;
    }
    async readFlash(addr, n) {
      calls.push(['readFlash', addr, n]);
      const out = flash.slice(addr, addr + n);
      tamperRead?.(addr, n, readCalls++, out);
      return out;
    }
    async flashMd5sum(addr, n) {
      calls.push(['flashMd5sum', addr, n]);
      return md5Hex(flash.slice(addr, addr + n));
    }
    async eraseFlash() {
      calls.push(['eraseFlash']);
      if (failErase) throw new Error('Timed out waiting for packet header');
      flash.fill(0xff);
    }
    async writeFlash(o) {
      writes.push(o);
      calls.push(['writeFlash', o.fileArray.map((f) => [f.address, f.data.length]), o.eraseAll, o.compress]);
      if (o.eraseAll) flash.fill(0xff);
      for (let i = 0; i < o.fileArray.length; i++) {
        o.calculateMD5Hash?.(o.fileArray[i].data);
        // Like esptool-js with compress: true, report progress in COMPRESSED bytes, in steps.
        const compressed = Math.floor(o.fileArray[i].data.length / 3);
        for (const w of [Math.floor(compressed / 2), compressed]) o.reportProgress?.(i, w, compressed);
        // The chip erases every whole 4 KiB sector the write touches before programming it.
        const { data, address } = o.fileArray[i];
        flash.fill(0xff, Math.floor(address / 0x1000) * 0x1000, Math.ceil((address + data.length) / 0x1000) * 0x1000);
        flash.set(data, address);
        // Exact message esptool-js 0.6.1 throws (lib/esploader.js line 1453).
        if (md5Mismatch) throw new Error('MD5 of file does not match data in flash!');
      }
      if (corruptAt !== null) flash[corruptAt] = (flash[corruptAt] + 1) & 0xff; // cumulative, so two writes never cancel out
    }
    async after(mode) {
      calls.push(['after', mode]);
      if (failReset) throw new Error('Failed to reset device');
    }
  }
  return { ESPLoader, Transport, calls, transports, loaders, writes, flash };
}
