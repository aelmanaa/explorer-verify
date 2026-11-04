/**
 * SHA-256 (FIPS 180-4, section 6.2), for the IPFS hash solc puts in the bytecode (decision 0026).
 * Written here rather than taken from `crypto.subtle`: that API is asynchronous, absent from
 * insecure browser contexts, and its types need the DOM library in every caller.
 *
 * Input is read through a `DataView`, big-endian, so the result does not depend on the platform's
 * byte order.
 */

/** The round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The initial hash: the first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

/** Element `index` of `array`. Every index used below is in range; `Number` keeps the type exact. */
function at(array: Uint32Array, index: number): number {
  return Number(array[index]);
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * The SHA-256 digest of `bytes`.
 *
 * @param bytes - The message.
 * @returns The 32-byte digest.
 */
export function sha256(bytes: Uint8Array): Uint8Array {
  // The message, the 0x80 byte, zeros, and the length in bits as 64 bits, to a multiple of 64 bytes.
  const blocks = Math.ceil((bytes.byteLength + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(bytes);
  const view = new DataView(padded.buffer);
  view.setUint8(bytes.byteLength, 0x80);
  view.setUint32(padded.byteLength - 8, Math.floor(bytes.byteLength / 0x20000000));
  view.setUint32(padded.byteLength - 4, (bytes.byteLength * 8) >>> 0);

  const hash = Uint32Array.from(INITIAL);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.byteLength; offset += 64) {
    for (let t = 0; t < 16; t++) {
      words[t] = view.getUint32(offset + t * 4);
    }
    for (let t = 16; t < 64; t++) {
      const early = at(words, t - 15);
      const late = at(words, t - 2);
      const s0 = rotr(early, 7) ^ rotr(early, 18) ^ (early >>> 3);
      const s1 = rotr(late, 17) ^ rotr(late, 19) ^ (late >>> 10);
      words[t] = at(words, t - 16) + s0 + at(words, t - 7) + s1;
    }
    let a = at(hash, 0);
    let b = at(hash, 1);
    let c = at(hash, 2);
    let d = at(hash, 3);
    let e = at(hash, 4);
    let f = at(hash, 5);
    let g = at(hash, 6);
    let h = at(hash, 7);
    for (let t = 0; t < 64; t++) {
      const t1 =
        (h +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          at(K, t) +
          at(words, t)) |
        0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    const round = [a, b, c, d, e, f, g, h];
    round.forEach((value, index) => {
      hash[index] = at(hash, index) + value;
    });
  }
  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  for (let index = 0; index < 8; index++) {
    out.setUint32(index * 4, at(hash, index));
  }
  return digest;
}
