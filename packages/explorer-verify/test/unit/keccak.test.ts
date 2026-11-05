// Tests for the internal Keccak-256 (decision 0012), used to check sources against Solidity
// metadata (R-IN-7). The vectors in test/fixtures/keccak256-vectors.json are shared with the
// browser smoke test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { keccak256, sponge256 } from "../../src/internal/keccak.ts";

const VECTORS: unknown = JSON.parse(
  readFileSync(new URL("../fixtures/keccak256-vectors.json", import.meta.url), "utf8"),
);
const SHA3_PADDING = 0x06;

/** The `vectors` of the fixture, each with its name, input bytes and digest. */
function vectors(): { name: string; input: Uint8Array; digest: string }[] {
  assert.ok(typeof VECTORS === "object" && VECTORS !== null && "vectors" in VECTORS);
  const list: unknown = VECTORS.vectors;
  assert.ok(Array.isArray(list));
  return list.map((entry: unknown) => {
    assert.ok(typeof entry === "object" && entry !== null);
    assert.ok("name" in entry && "inputHex" in entry && "digest" in entry);
    const { name, inputHex, digest } = entry;
    assert.ok(typeof name === "string" && typeof inputHex === "string");
    assert.ok(typeof digest === "string");
    return { name, input: Uint8Array.from(Buffer.from(inputHex, "hex")), digest };
  });
}

/** Deterministic bytes: no randomness, so a failure names a length that always fails. */
function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 31 + length * 7) & 0xff);
}

describe("keccak256 (R-IN-7, decision 0012)", () => {
  it('gives the published digests for the empty input, "abc" and a 200-byte input', () => {
    const list = vectors();
    assert.deepEqual(
      list.map(({ name }) => name),
      ["empty input", '"abc"', "200 bytes of 0xa3, more than one 136-byte block"],
    );
    for (const { name, input, digest } of list) {
      assert.equal(keccak256(input), digest, name);
    }
    assert.equal(list[2]?.input.length, 200);
  });

  it("gives the hash solc recorded for each fixture source", () => {
    const encoder = new TextEncoder();
    const read = (path: string): Uint8Array =>
      encoder.encode(
        readFileSync(new URL(`../fixtures/build-formats/${path}`, import.meta.url), "utf8"),
      );
    // From the metadata of the build-format fixtures, written by solc 0.8.24.
    const recorded: [string, string][] = [
      ["sources/Base.sol", "0xc935aaf5ff95faa284edecea19897c2d6125bb66b0f006d2917cabd4f66632ba"],
      ["sources/Greeter.sol", "0xa130d93deff246f7f1d3cf1b421dc9df82f2e51fa215f64787ca22c634339d8d"],
      [
        "solc-0.8.24-library/src/Counter.sol",
        "0x473d70d8a16a3110e6a7ba9380b10a9b396d560b0ad291aa30db3cd5f700113d",
      ],
      [
        "solc-0.8.24-library/src/Tally.sol",
        "0x32dd19fd952c220a21d269a47dfb3dea59f2a01c44e3aef8c8bfe0a3439a4f9e",
      ],
    ];
    for (const [path, hash] of recorded) {
      assert.equal(keccak256(read(path)), hash, path);
    }
  });

  it("is the Keccak sponge: with the SHA-3 padding it equals node:crypto sha3-256 for 0 to 600 bytes", () => {
    for (let length = 0; length <= 600; length++) {
      const input = pattern(length);
      const expected = `0x${createHash("sha3-256").update(input).digest("hex")}`;
      assert.equal(sponge256(input, SHA3_PADDING), expected, `length ${String(length)}`);
    }
  });

  it("equals node:crypto sha3-256 for 200 pseudo-random inputs of up to 5000 bytes", () => {
    // A fixed linear congruential generator: the same inputs on every run.
    let seed = 20_261_103;
    const next = (): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed;
    };
    for (let count = 0; count < 200; count++) {
      const input = Uint8Array.from({ length: next() % 5001 }, () => next() & 0xff);
      const expected = `0x${createHash("sha3-256").update(input).digest("hex")}`;
      assert.equal(sponge256(input, SHA3_PADDING), expected, `length ${String(input.length)}`);
    }
  });

  it("hashes 1 MB: the Keccak-256 digest of another implementation, and node:crypto sha3-256 with SHA-3 padding", () => {
    // 1 MiB of 0x61 is 7,710 full blocks and a last partial one. The Keccak-256 digest is from
    // Foundry's `cast keccak` 1.8.1 (2026-11-05), an implementation independent of this one.
    const input = new Uint8Array(1024 * 1024).fill(0x61);
    assert.equal(
      keccak256(input),
      "0xf5f3e54ad3d703f8e9edfd7ce79341b1d9286a692fa6c13ff13ee6ea94dbf97d",
    );
    const expected = `0x${createHash("sha3-256").update(input).digest("hex")}`;
    assert.equal(sponge256(input, SHA3_PADDING), expected);
  });

  // A wall-clock limit depends on the machine's load: under load averages above 100 this check
  // took over two seconds while the code had not changed (#163). So it runs only on request, on an
  // idle machine: KECCAK_BENCH=1. It is also meaningless under block coverage (c8 sets
  // NODE_V8_COVERAGE), which slows this loop many times over.
  const timed =
    process.env["KECCAK_BENCH"] === "1" && process.env["NODE_V8_COVERAGE"] === undefined;
  it(
    "hashes 1 MB in under two seconds, best of three runs (KECCAK_BENCH=1)",
    {
      skip: timed ? false : "set KECCAK_BENCH=1, without coverage",
    },
    () => {
      // About 0.15 s on an idle laptop (2026-11-03). The first implementation took about 4 s and
      // would fail.
      const input = new Uint8Array(1024 * 1024).fill(0x61);
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        keccak256(input);
        best = Math.min(best, performance.now() - start);
      }
      assert.ok(best < 2000, `1 MB took ${String(Math.round(best))} ms at best`);
    },
  );

  it("pads the 135-byte and 136-byte inputs at the block edge", () => {
    // 135 bytes: the padding byte and 0x80 share the last byte of the block. 136 bytes: a whole
    // block of padding follows.
    for (const length of [135, 136, 271, 272]) {
      const input = pattern(length);
      const expected = `0x${createHash("sha3-256").update(input).digest("hex")}`;
      assert.equal(sponge256(input, SHA3_PADDING), expected, `length ${String(length)}`);
    }
  });

  it("reads only the view it is given, at any offset in its buffer", () => {
    const whole = pattern(300);
    const view = whole.subarray(3, 203);
    assert.equal(keccak256(view), keccak256(Uint8Array.from(view)));
  });

  it("returns 0x and 64 lowercase hex digits, and differs for a one-byte change", () => {
    const input = pattern(64);
    const changed = Uint8Array.from(input);
    changed[10] = (input[10] ?? 0) ^ 1;
    const digest = keccak256(input);
    assert.match(digest, /^0x[0-9a-f]{64}$/);
    assert.notEqual(keccak256(changed), digest);
  });
});
