// References: decision 0012.
/**
 * Keccak-256, the hash solc records for each source in the Solidity metadata. It
 * is the Keccak sponge with a 1088-bit rate and the original Keccak padding (`0x01 … 0x80`), not
 * the SHA3-256 padding of FIPS 202 (`0x06 … 0x80`). Written from the specification:
 * https://keccak.team/keccak_specs_summary.html and FIPS 202, section 3.2.
 *
 * The state is 25 lanes of 64 bits in a `Uint32Array`: lane `i` is the low half at `2i` and the
 * high half at `2i + 1`. Input is read through a `DataView`, little-endian, so the result does not
 * depend on the platform's byte order.
 */

/** The rate of Keccak-256 in bytes: 1600 - 2 * 256 bits. */
const RATE = 136;
/** The first padding byte of the original Keccak, as used by Ethereum and solc. */
const KECCAK_PADDING = 0x01;
const ROUNDS = 24;
const OUTPUT_BYTES = 32;

/** Element `index` of `array`. Every index used below is in range; `Number` keeps the type exact. */
function at(array: Uint32Array | Uint8Array, index: number): number {
  return Number(array[index]);
}

/**
 * The 24 round constants as low and high halves, from the specification's LFSR
 * x^8 + x^6 + x^5 + x^4 + 1: round `r` sets bit `2^j - 1` for each of its seven output bits `j`.
 */
function roundConstants(): Uint32Array {
  const constants = new Uint32Array(ROUNDS * 2);
  let lfsr = 1;
  for (let round = 0; round < ROUNDS; round++) {
    for (let j = 0; j < 7; j++) {
      if ((lfsr & 1) !== 0) {
        const bit = (1 << j) - 1;
        const half = round * 2 + (bit < 32 ? 0 : 1);
        constants[half] = at(constants, half) | (1 << (bit % 32));
      }
      lfsr = ((lfsr << 1) ^ ((lfsr >> 7) * 0x71)) & 0xff;
    }
  }
  return constants;
}

/**
 * The rho and pi steps as one walk over the lanes: `(x, y) -> (y, 2x + 3y)`, starting at lane
 * `(1, 0)`. Step `t` moves a lane to `LANE_ORDER[t]` and rotates it by the triangular number
 * `(t + 1)(t + 2) / 2 mod 64`.
 */
function rhoPi(): { order: Uint8Array; rotation: Uint8Array } {
  const order = new Uint8Array(ROUNDS);
  const rotation = new Uint8Array(ROUNDS);
  let x = 1;
  let y = 0;
  for (let t = 0; t < ROUNDS; t++) {
    const next = (2 * x + 3 * y) % 5;
    x = y;
    y = next;
    order[t] = x + 5 * y;
    rotation[t] = (((t + 1) * (t + 2)) / 2) % 64;
  }
  return { order, rotation };
}

const ROUND_CONSTANTS = roundConstants();
const { order: LANE_ORDER, rotation: LANE_ROTATION } = rhoPi();

/** Keccak-f[1600]: 24 rounds of theta, rho, pi, chi and iota on `state`, with `row` as scratch. */
function permute(state: Uint32Array, row: Uint32Array): void {
  for (let round = 0; round < ROUNDS; round++) {
    // Theta: the column parities, then each lane gets C[x - 1] ^ rotl(C[x + 1], 1).
    for (let x = 0; x < 10; x++) {
      row[x] =
        at(state, x) ^
        at(state, x + 10) ^
        at(state, x + 20) ^
        at(state, x + 30) ^
        at(state, x + 40);
    }
    for (let x = 0; x < 10; x += 2) {
      const before = (x + 8) % 10;
      const after = (x + 2) % 10;
      const afterLo = at(row, after);
      const afterHi = at(row, after + 1);
      const lo = at(row, before) ^ ((afterLo << 1) | (afterHi >>> 31));
      const hi = at(row, before + 1) ^ ((afterHi << 1) | (afterLo >>> 31));
      for (let y = 0; y < 50; y += 10) {
        state[x + y] = at(state, x + y) ^ lo;
        state[x + y + 1] = at(state, x + y + 1) ^ hi;
      }
    }
    // Rho and pi: each lane moves along the walk and is rotated. No offset is 0 or 32.
    let carryLo = at(state, 2);
    let carryHi = at(state, 3);
    for (let t = 0; t < ROUNDS; t++) {
      const index = at(LANE_ORDER, t) * 2;
      const bits = at(LANE_ROTATION, t);
      const lo = at(state, index);
      const hi = at(state, index + 1);
      if (bits < 32) {
        state[index] = (carryLo << bits) | (carryHi >>> (32 - bits));
        state[index + 1] = (carryHi << bits) | (carryLo >>> (32 - bits));
      } else {
        const shift = bits - 32;
        state[index] = (carryHi << shift) | (carryLo >>> (32 - shift));
        state[index + 1] = (carryLo << shift) | (carryHi >>> (32 - shift));
      }
      carryLo = lo;
      carryHi = hi;
    }
    // Chi, one row of five lanes at a time, from a copy of the row.
    for (let y = 0; y < 50; y += 10) {
      for (let x = 0; x < 10; x++) {
        row[x] = at(state, y + x);
      }
      for (let x = 0; x < 10; x++) {
        state[y + x] = at(row, x) ^ (~at(row, (x + 2) % 10) & at(row, (x + 4) % 10));
      }
    }
    // Iota.
    state[0] = at(state, 0) ^ at(ROUND_CONSTANTS, round * 2);
    state[1] = at(state, 1) ^ at(ROUND_CONSTANTS, round * 2 + 1);
  }
}

/** XORs one block of {@link RATE} bytes from `block` at `offset` into the state, word by word. */
function absorb(state: Uint32Array, block: DataView, offset: number): void {
  for (let word = 0; word < RATE / 4; word++) {
    state[word] = at(state, word) ^ block.getUint32(offset + word * 4, true);
  }
}

/**
 * The 256-bit sponge over `bytes` with the first padding byte `padding`, as `0x` and 64 lowercase
 * hex digits. `0x01` gives Keccak-256; `0x06` gives SHA3-256, which the tests compare with
 * `node:crypto` on many lengths.
 */
export function sponge256(bytes: Uint8Array, padding: number): string {
  const state = new Uint32Array(50);
  const row = new Uint32Array(10);
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const full = bytes.byteLength - (bytes.byteLength % RATE);
  for (let offset = 0; offset < full; offset += RATE) {
    absorb(state, input, offset);
    permute(state, row);
  }
  // The last block: the remaining bytes, the padding byte, zeros, then 0x80 in the last byte. When
  // one byte remains free, the padding byte and 0x80 share it.
  const last = new Uint8Array(RATE);
  last.set(bytes.subarray(full));
  const tail = new DataView(last.buffer);
  tail.setUint8(bytes.byteLength - full, padding);
  tail.setUint8(RATE - 1, tail.getUint8(RATE - 1) | 0x80);
  absorb(state, tail, 0);
  permute(state, row);
  let hex = "0x";
  for (let index = 0; index < OUTPUT_BYTES; index++) {
    const word = at(state, index >> 2);
    hex += ((word >>> ((index & 3) * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * The Keccak-256 hash of `bytes`, as `0x` and 64 lowercase hex digits, the form solc writes in
 * the metadata's `sources[path].keccak256`.
 */
export function keccak256(bytes: Uint8Array): string {
  return sponge256(bytes, KECCAK_PADDING);
}
