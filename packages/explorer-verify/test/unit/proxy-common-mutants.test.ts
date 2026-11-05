// Tests added when the proxy-link code joined mutation testing (#194; R-FLOW-8, R-FLOW-4): each
// one fails on a code change in src/backends/proxy-common.ts that the linkProxy() tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Context } from "../../src/backends/backend.ts";
import {
  foundImplementation,
  implementationOf,
  unknownLink,
} from "../../src/backends/proxy-common.ts";
import { resolveRoute } from "../helpers/route.ts";

const PROXY = "0xed5b8413e605598ef86cd7617f12701f74ca255c";
const OTHER_PROXY = "0xfa0e910758d502780263871f92a85736597b87f4";
const BOX = "0x75038a8c55f5ec7196b54384fdbcffb1f2ce9920";

/** The "found at" text of one implementation. */
function one(proxy: string, rest = "is successfully updated."): string {
  return `The proxy's (${proxy}) implementation contract is found at ${BOX} and ${rest}`;
}

/** Blockscout's "found at" text of no implementation. */
function none(proxy: string, rest = "is successfully updated."): string {
  return `The proxy's (${proxy}) implementation contracts are found at [] and ${rest}`;
}

describe("foundImplementation(): only the whole answer is read (R-FLOW-8, R-FLOW-4)", () => {
  it("reads one implementation, and no implementation, with the text after it", () => {
    assert.deepEqual(foundImplementation(one(PROXY), PROXY), {
      kind: "one",
      implementation: BOX,
      rest: "is successfully updated.",
    });
    assert.deepEqual(foundImplementation(none(PROXY), PROXY), {
      kind: "none",
      rest: "is successfully updated.",
    });
  });

  it("reads nothing from an answer with text before the sentence", () => {
    assert.equal(foundImplementation(`Note: ${one(PROXY)}`, PROXY), undefined);
    assert.equal(foundImplementation(`Note: ${none(PROXY)}`, PROXY), undefined);
  });

  it("reads nothing from an answer with a second line after the sentence", () => {
    assert.equal(foundImplementation(`${one(PROXY)}\nmore`, PROXY), undefined);
    assert.equal(foundImplementation(`${none(PROXY)}\nmore`, PROXY), undefined);
  });

  it("reads nothing when the answer names another proxy, with or without an implementation", () => {
    assert.equal(foundImplementation(one(OTHER_PROXY), PROXY), undefined);
    assert.equal(foundImplementation(none(OTHER_PROXY), PROXY), undefined);
  });
});

describe("implementationOf(): one address exactly (R-FLOW-8)", () => {
  it("gives the address in lower case", () => {
    assert.equal(implementationOf(`0x${BOX.slice(2).toUpperCase()}`), BOX);
  });

  it("gives undefined for an address with text before it", () => {
    assert.equal(implementationOf(`10${BOX}`), undefined);
  });

  it("gives undefined for a value that is not a string, even one whose text is an address", () => {
    assert.equal(implementationOf({ toString: () => BOX }), undefined);
    assert.equal(implementationOf(undefined), undefined);
  });

  it("gives undefined for the zero address", () => {
    assert.equal(implementationOf(`0x${"0".repeat(40)}`), undefined);
  });
});

describe("unknownLink(): the error for an answer the client does not know (R-FLOW-4)", () => {
  it("says the link state is not known, and carries the answer as its excerpt", () => {
    const ctx: Context = {
      route: resolveRoute(11155111, {
        backend: "blockscout",
        apiUrl: "https://eth-sepolia.blockscout.com/api",
      }),
      http: { backend: "blockscout", secrets: [] },
    };
    const error = unknownLink(ctx, "blockscout", "Blockscout", {
      status: 200,
      text: "Unknown UID",
      fields: undefined,
    });
    assert.equal(error.code, "proxy-link-unknown-state");
    assert.equal(
      error.message,
      "Blockscout reported a proxy link state that this client does not recognise; whether the proxy is linked is not known.",
    );
    assert.equal(
      error.details.code === "proxy-link-unknown-state" && error.details.excerpt,
      "Unknown UID",
    );
  });
});
