/**
 * Reads the metadata hash from the CBOR block solc appends to the runtime bytecode
 * (https://docs.soliditylang.org/en/v0.8.30/metadata.html#encoding-of-the-metadata-hash-in-the-bytecode).
 * The last two bytes hold the block's length, big-endian; the block before them is a CBOR map whose
 * keys are text: `ipfs` (a 34-byte multihash), `bzzr0` or `bzzr1` (a 32-byte Swarm hash), `solc`
 * (the compiler version) and `experimental` (a boolean). Only the parts of CBOR that solc writes
 * are read: a map of at most 23 entries, text keys, and byte string, text or boolean values.
 * Anything else counts as no metadata.
 */
import { base58 } from "./ipfs.ts";

/** What the end of the bytecode holds. */
export type Auxdata =
  /** No bytecode: nothing is deployed at the address. */
  | { readonly kind: "no-code" }
  /** No CBOR block that solc could have written, as with `appendCBOR: false`. */
  | { readonly kind: "no-metadata" }
  /** A CBOR block with no hash, as with `bytecodeHash: "none"`. */
  | { readonly kind: "version-only" }
  /** An IPFS hash, as a CIDv0. */
  | { readonly kind: "ipfs"; readonly cid: string }
  /** A Swarm hash, `bzzr0` or `bzzr1`, as 64 lowercase hex digits. */
  | { readonly kind: "swarm"; readonly key: "bzzr0" | "bzzr1"; readonly hex: string };

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

/** `text`, `0x` and an even number of hex digits, as bytes, or `undefined` when it is not. */
export function hexBytes(text: string): Uint8Array | undefined {
  if (!HEX.test(text)) {
    return undefined;
  }
  const bytes = new Uint8Array((text.length - 2) / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(text.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A CBOR value that solc writes: bytes, text or a boolean. */
type Item =
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "text"; value: string }
  | { kind: "bool" };

/** Reads CBOR items from `block`, one at a time. Throws on anything solc does not write. */
class Reader {
  private offset = 0;
  private readonly block: Uint8Array;

  constructor(block: Uint8Array) {
    this.block = block;
  }

  get done(): boolean {
    return this.offset === this.block.length;
  }

  byte(): number {
    const value = this.block[this.offset];
    if (value === undefined) {
      throw new RangeError("the CBOR block ends early");
    }
    this.offset += 1;
    return value;
  }

  /** The length of an item whose first byte had `info` in its low five bits. */
  length(info: number): number {
    if (info < 24) {
      return info;
    }
    if (info === 24) {
      return this.byte();
    }
    if (info === 25) {
      return this.byte() * 256 + this.byte();
    }
    throw new RangeError("unsupported CBOR length");
  }

  take(count: number): Uint8Array {
    if (this.offset + count > this.block.length) {
      throw new RangeError("the CBOR block ends early");
    }
    const bytes = this.block.subarray(this.offset, this.offset + count);
    this.offset += count;
    return bytes;
  }

  item(): Item {
    const first = this.byte();
    const major = first >> 5;
    const info = first & 0x1f;
    if (major === 2) {
      return { kind: "bytes", value: this.take(this.length(info)) };
    }
    if (major === 3) {
      return { kind: "text", value: new TextDecoder().decode(this.take(this.length(info))) };
    }
    if (first === 0xf4 || first === 0xf5) {
      return { kind: "bool" };
    }
    throw new RangeError("unsupported CBOR item");
  }
}

/** The map entries of `block`, or `undefined` when it is not a CBOR map that solc writes. */
function readMap(block: Uint8Array): Map<string, Item> | undefined {
  try {
    const reader = new Reader(block);
    const first = reader.byte();
    if (first >> 5 !== 5 || (first & 0x1f) >= 24) {
      return undefined;
    }
    const entries = new Map<string, Item>();
    for (let count = first & 0x1f; count > 0; count--) {
      const key = reader.item();
      if (key.kind !== "text") {
        return undefined;
      }
      entries.set(key.value, reader.item());
    }
    return reader.done ? entries : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the end of `bytecode` holds: an IPFS or Swarm metadata hash, a version-only block, no
 * block, or no code at all.
 *
 * @param bytecode - The runtime bytecode.
 * @returns The hash, or why there is none.
 */
export function readAuxdata(bytecode: Uint8Array): Auxdata {
  if (bytecode.length === 0) {
    return { kind: "no-code" };
  }
  const size = bytecode.length;
  const length = size >= 2 ? Number(bytecode[size - 2]) * 256 + Number(bytecode[size - 1]) : 0;
  const entries =
    length === 0 || length + 2 > size
      ? undefined
      : readMap(bytecode.subarray(size - 2 - length, size - 2));
  if (entries === undefined) {
    return { kind: "no-metadata" };
  }
  const ipfs = entries.get("ipfs");
  if (
    ipfs?.kind === "bytes" &&
    ipfs.value.length === 34 &&
    ipfs.value[0] === 0x12 &&
    ipfs.value[1] === 0x20
  ) {
    return { kind: "ipfs", cid: base58(ipfs.value) };
  }
  for (const key of ["bzzr1", "bzzr0"] as const) {
    const swarm = entries.get(key);
    if (swarm?.kind === "bytes" && swarm.value.length === 32) {
      return { kind: "swarm", key, hex: toHex(swarm.value) };
    }
  }
  return entries.has("solc") ? { kind: "version-only" } : { kind: "no-metadata" };
}
