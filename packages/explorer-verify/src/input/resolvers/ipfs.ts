/**
 * The IPFS hash solc appends to the bytecode, computed the way solc computes it
 * (libsolutil/IpfsHash.cpp): the file is cut into chunks of 256 KiB, each chunk becomes a UnixFS
 * file node in a DAG-PB block, and the CIDv0 of the root block is the base58btc text of the
 * multihash `0x12 0x20 <sha256 of the block>`. A file of more than one chunk gets one parent
 * block that links every chunk. solc adds a second level of parents above 174 chunks, about
 * 43 MiB; the HTTP layer never reads a body that large, so one level is enough here.
 *
 * Blocks are built in preallocated `Uint8Array`s with `set`, so a file of several MiB is hashed
 * without per-byte arrays.
 */
import { sha256 } from "../../internal/sha256.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** The chunk size solc uses: 256 KiB. */
const CHUNK_BYTES = 262_144;

/** `bytes` in base58btc, the text form of a CIDv0. */
export function base58(bytes: Uint8Array): string {
  // Base-58 digits, least significant first.
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index++) {
      carry += Number(digits[index]) * 256;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let text = "";
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    text += "1";
  }
  for (let index = digits.length - 1; index >= 0; index--) {
    text += ALPHABET.charAt(Number(digits[index]));
  }
  return text;
}

/** `value` as a protobuf varint. */
function varint(value: number): Uint8Array {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return Uint8Array.from(out);
}

/** The parts joined into one new array. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** A length-delimited protobuf field: the tag byte, the length and the bytes. */
function field(tag: number, bytes: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(tag), varint(bytes.byteLength), bytes]);
}

/** The multihash of a block: sha2-256 (`0x12`), 32 bytes (`0x20`), then the digest. */
function multihash(block: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(0x12, 0x20), sha256(block)]);
}

/**
 * The CIDv0 of `bytes` as solc computes it, such as
 * `QmQXfzJLPTjPUD1LWY6XQHqnWgqgDYEravjDpAMCtW4Uvb`.
 *
 * @param bytes - The file, here the metadata JSON as UTF-8.
 * @returns The CID in base58btc.
 */
export function ipfsCid(bytes: Uint8Array): string {
  const chunks: { hash: Uint8Array; size: number; blockSize: number }[] = [];
  let offset = 0;
  do {
    const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
    // UnixFS Data: Type File (field 1 = 2), Data (field 2) when not empty, filesize (field 3).
    const unixfs = concat([
      Uint8Array.of(0x08, 0x02),
      chunk.byteLength > 0 ? field(0x12, chunk) : new Uint8Array(),
      Uint8Array.of(0x18),
      varint(chunk.byteLength),
    ]);
    // DAG-PB PBNode with only Data (field 1).
    const block = field(0x0a, unixfs);
    chunks.push({ hash: multihash(block), size: chunk.byteLength, blockSize: block.byteLength });
    offset += CHUNK_BYTES;
  } while (offset < bytes.byteLength);
  const [only] = chunks;
  if (only !== undefined && chunks.length === 1) {
    return base58(only.hash);
  }
  // The parent: Links (field 2) first, each with Hash (1), an empty Name (2) and Tsize (3), then
  // Data (field 1) with Type File, filesize and one blocksizes entry (field 4) per chunk.
  const parts: Uint8Array[] = [];
  const sizes: Uint8Array[] = [];
  for (const { hash, size, blockSize } of chunks) {
    const link = concat([field(0x0a, hash), Uint8Array.of(0x12, 0x00, 0x18), varint(blockSize)]);
    parts.push(field(0x12, link));
    sizes.push(Uint8Array.of(0x20), varint(size));
  }
  const data = concat([Uint8Array.of(0x08, 0x02, 0x18), varint(bytes.byteLength), ...sizes]);
  parts.push(field(0x0a, data));
  return base58(multihash(concat(parts)));
}
