import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addressDigits, readChainId, readFields } from "../../src/internal/read-fields.ts";

const DIGITS = "5FbDB2315678afecb367f032d93F642f64180aa3";

function fail(): never {
  throw new Error("trap");
}

describe("readFields", () => {
  it("returns the own enumerable fields in order", () => {
    const fields = readFields({ b: 2, a: undefined, c: "x" });
    assert.deepEqual(
      fields,
      new Map<string, unknown>([
        ["b", 2],
        ["a", undefined],
        ["c", "x"],
      ]),
    );
  });

  it("returns an empty map for an empty object and a null-prototype object", () => {
    assert.equal(readFields({})?.size, 0);
    const bare: Record<string, unknown> = Object.create(null);
    bare["k"] = 1;
    assert.deepEqual(readFields(bare), new Map([["k", 1]]));
  });

  it("ignores inherited, non-enumerable and symbol fields", () => {
    const value: Record<string, unknown> = Object.create({ inherited: 1 });
    Object.defineProperty(value, "hidden", { value: 2, enumerable: false });
    Object.defineProperty(value, Symbol("s"), { value: 3, enumerable: true });
    value["own"] = 4;
    assert.deepEqual(readFields(value), new Map([["own", 4]]));
  });

  it("reads each getter once", () => {
    let reads = 0;
    const value = {
      get field(): number {
        reads++;
        return reads;
      },
    };
    const fields = readFields(value);
    assert.equal(fields?.get("field"), 1);
    assert.equal(fields?.get("field"), 1);
    assert.equal(reads, 1);
  });

  for (const [name, value] of [
    ["undefined", undefined],
    ["null", null],
    ["a string", "text"],
    ["a number", 1],
    ["a boolean", true],
    ["a bigint", 1n],
    ["a symbol", Symbol("s")],
    ["a function", (): number => 1],
    ["an array", [1, 2]],
    ["an empty array", []],
  ] satisfies [string, unknown][]) {
    it(`returns undefined for ${name}`, () => {
      assert.equal(readFields(value), undefined);
    });
  }

  it("returns undefined for a Proxy of an array", () => {
    assert.equal(readFields(new Proxy([1], {})), undefined);
  });

  it("returns undefined when a getter throws, and drops the error", () => {
    const value = {
      get field(): never {
        throw new Error("secret value");
      },
    };
    assert.equal(readFields(value), undefined);
  });

  it("returns undefined when a Proxy trap throws", () => {
    assert.equal(readFields(new Proxy({}, { ownKeys: fail })), undefined);
    assert.equal(readFields(new Proxy({ a: 1 }, { getOwnPropertyDescriptor: fail })), undefined);
    assert.equal(readFields(new Proxy({ a: 1 }, { get: fail })), undefined);
  });

  it("returns undefined for a revoked Proxy, where the array check throws", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    assert.equal(readFields(proxy), undefined);
  });
});

describe("addressDigits", () => {
  it("returns the 40 digits after 0x in the case given", () => {
    assert.equal(addressDigits(`0x${DIGITS}`), DIGITS);
    assert.equal(addressDigits(`0x${DIGITS.toUpperCase()}`), DIGITS.toUpperCase());
  });

  for (const [name, value] of [
    ["39 digits", `0x${DIGITS.slice(1)}`],
    ["41 digits", `0x${DIGITS}0`],
    ["no prefix", DIGITS],
    ["an upper-case prefix", `0X${DIGITS}`],
    ["a non-hex digit", `0x${DIGITS.slice(1)}g`],
    ["a leading space", ` 0x${DIGITS}`],
    ["a trailing newline", `0x${DIGITS}\n`],
    ["an empty string", ""],
    ["a number", 1],
    ["undefined", undefined],
    ["a String object", new String(`0x${DIGITS}`)],
  ] satisfies [string, unknown][]) {
    it(`returns undefined for ${name}`, () => {
      assert.equal(addressDigits(value), undefined);
    });
  }
});

describe("readChainId", () => {
  for (const value of [1, 11155111, Number.MAX_SAFE_INTEGER]) {
    it(`accepts ${String(value)}`, () => {
      assert.equal(readChainId(value), value);
    });
  }

  for (const [name, value] of [
    ["0", 0],
    ["-0", -0],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["a numeric string", "1"],
    ["a bigint", 1n],
    ["undefined", undefined],
    ["a Number object", new Number(1)],
  ] satisfies [string, unknown][]) {
    it(`rejects ${name}`, () => {
      assert.equal(readChainId(value), undefined);
    });
  }
});
