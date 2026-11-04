// Tests for the internal SHA-256 (decision 0026), used for the IPFS hash in the bytecode (R-IN-5).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { sha256 } from "../../src/internal/sha256.ts";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function reference(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Deterministic bytes: no randomness, so a failure names a length that always fails. */
function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 131 + length * 17) & 0xff);
}

describe("sha256 (R-IN-5, decision 0026)", () => {
  it('gives the FIPS 180-4 digests of the empty input and "abc"', () => {
    assert.equal(
      hex(sha256(new Uint8Array())),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    assert.equal(
      hex(sha256(new TextEncoder().encode("abc"))),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches node:crypto for every length from 0 to 300 bytes, across block edges", () => {
    for (let length = 0; length <= 300; length++) {
      const bytes = pattern(length);
      assert.equal(hex(sha256(bytes)), reference(bytes), `length ${String(length)}`);
    }
  });

  it("matches node:crypto on inputs up to 300 KiB, and on a view into a larger buffer", () => {
    for (const length of [1_000, 4_095, 65_536, 300_001]) {
      const bytes = pattern(length);
      assert.equal(hex(sha256(bytes)), reference(bytes), `length ${String(length)}`);
    }
    const view = pattern(1_000).subarray(10, 510);
    assert.equal(hex(sha256(view)), reference(view));
  });
});
