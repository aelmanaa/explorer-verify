// Tests added after the first full mutation run (#158; R-SEC-1, R-SEC-2): each one fails on a code
// change in src/http/api-keys.ts that the other key tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError } from "../../src/errors.ts";
import { keyErrorOf, keyFor, readApiKeys, requireKey } from "../../src/http/api-keys.ts";
import { REDACTED } from "../../src/redact.ts";
import type { Route } from "../../src/routing/resolve.ts";

const STANDALONE_API = "https://explorer.example.org/api";
const STANDALONE_KEY = "standalone-dummy-key-158a";

function standaloneRoute(): Route {
  return {
    backend: "etherscan-compatible",
    apiBase: STANDALONE_API,
    redactedApiUrl: STANDALONE_API,
    requestUrl: (path: string): string => `${STANDALONE_API}${path}`,
    explorerUrl: undefined,
    apiKey: () => STANDALONE_KEY,
    overridden: true,
    tableHost: undefined,
  };
}

function thrown(run: () => unknown): ExplorerVerifyError {
  try {
    run();
  } catch (error: unknown) {
    assert.ok(error instanceof ExplorerVerifyError, "expected an ExplorerVerifyError");
    return error;
  }
  return assert.fail("expected an ExplorerVerifyError");
}

/** Two functions, each given the prototype a plain object can have, and a key below. */
function nullPrototype(): void {}
function objectPrototype(): void {}

/** `value` with `prototype` and a key: still not a plain object. */
function withKey(value: () => void, prototype: object | null): object {
  Object.setPrototypeOf(value, prototype);
  return Object.assign(value, { "etherscan-v2": "etherscan-dummy-key-158c" });
}

describe("readApiKeys: only a plain object holds keys (#158, R-SEC-1)", () => {
  it("refuses a function whose prototype is null or Object.prototype", () => {
    for (const value of [
      withKey(nullPrototype, null),
      withKey(objectPrototype, Object.prototype),
    ]) {
      const read = readApiKeys(value);
      assert.deepEqual(read.keys, {});
      assert.deepEqual(read.issues, [{ field: "apiKeys", message: "must be a plain object" }]);
    }
  });
});

describe("keyFor: a route key stays on the route's origin (#158, R-SEC-2)", () => {
  it("returns no route.apiKey for a URL on another origin, or one that does not parse", () => {
    const ctx = { route: standaloneRoute() };
    assert.equal(
      keyFor(ctx, "etherscan-compatible", `${STANDALONE_API}?chainid=1`),
      STANDALONE_KEY,
    );
    assert.equal(keyFor(ctx, "etherscan-compatible", "https://attacker.example/api"), undefined);
    assert.equal(keyFor(ctx, "etherscan-compatible", "not a url"), undefined);
  });

  it("gives no route.apiKey when neither the URL nor the route's API base parses", () => {
    // Two missing origins are not the same origin.
    const route: Route = { ...standaloneRoute(), apiBase: "not a url" };
    assert.equal(keyFor({ route }, "etherscan-compatible", "not a url"), undefined);
  });

  it("gives no apiKeys key to a route without a table host, even on the host `undefined`", () => {
    // `https://${tableHost}` must not be compared when there is no table host.
    const apiBase = "https://undefined/v2/api";
    const route: Route = {
      backend: "etherscan-v2",
      apiBase,
      redactedApiUrl: apiBase,
      requestUrl: (path: string): string => `${apiBase}${path}`,
      explorerUrl: undefined,
      apiKey: () => undefined,
      overridden: false,
      tableHost: undefined,
    };
    const ctx = { route, apiKeys: () => ({ "etherscan-v2": "etherscan-dummy-key-158b" }) };
    assert.equal(keyFor(ctx, "etherscan-v2", `${apiBase}?chainid=1`), undefined);
  });
});

describe("keyErrorOf: messages and secrets (#158, R-SEC-1)", () => {
  it("says which key answer the explorer gave", () => {
    const missing = keyErrorOf(
      "etherscan-v2",
      { status: "0", message: "NOTOK", result: "Missing/Invalid API Key" },
      [],
    );
    assert.equal(missing?.message, "etherscan-v2 answered that the API key is missing.");
    const spent = keyErrorOf(
      "routescan",
      { status: "0", message: "NOTOK", result: "Max daily rate limit reached" },
      [],
    );
    assert.equal(spent?.code, "quota-exceeded");
    assert.equal(spent?.message, "routescan answered that the API key's daily limit is spent.");
  });

  it("removes the call's secrets from the error", () => {
    // A secret that matches the message shows that the secrets reach the error.
    const error = keyErrorOf(
      "etherscan-v2",
      { status: "0", message: "NOTOK", result: "Missing/Invalid API Key" },
      ["etherscan-v2"],
    );
    assert.equal(error?.message, `${REDACTED} answered that the API key is missing.`);
  });
});

describe("requireKey: secrets (#158, R-SEC-1)", () => {
  it("removes the call's secrets from the missing-api-key error", () => {
    const route: Route = {
      backend: "etherscan-v2",
      apiBase: "https://api.etherscan.io/v2/api",
      redactedApiUrl: "https://api.etherscan.io/v2/api",
      requestUrl: (path: string): string => `https://api.etherscan.io/v2/api${path}`,
      explorerUrl: undefined,
      apiKey: () => undefined,
      overridden: false,
      tableHost: "api.etherscan.io",
    };
    // A secret equal to the backend name shows that the secrets reach the error.
    const error = thrown(() => {
      requireKey({ route }, false, ["etherscan-v2"]);
    });
    assert.equal(error.code, "missing-api-key");
    assert.ok(!error.message.includes("etherscan-v2"), error.message);
    assert.ok(error.message.startsWith(`${REDACTED} needs an API key`), error.message);
  });
});
