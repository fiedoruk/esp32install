/** MD5 (RFC 1321). Used only so esptool-js can compare the image with the chip's flash MD5 after writing. */
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
const rotl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;

export function md5Hex(input) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bitLen = src.length * 8;
  const paddedLen = (((src.length + 8) >>> 6) + 1) * 64;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  const block = new Uint8Array(64);
  const view = new DataView(block.buffer);
  for (let off = 0; off < paddedLen; off += 64) {
    if (off + 64 <= src.length) {
      block.set(src.subarray(off, off + 64));
    } else {
      block.fill(0);
      if (off < src.length) block.set(src.subarray(off));
      if (off <= src.length && src.length < off + 64) block[src.length - off] = 0x80;
      if (off + 64 === paddedLen) {
        view.setUint32(56, bitLen >>> 0, true);
        view.setUint32(60, Math.floor(bitLen / 0x100000000), true);
      }
    }
    for (let j = 0; j < 16; j++) M[j] = view.getUint32(j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B; B = (B + rotl(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}
