import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError } from "../../src/index.ts";
import type { Hex, RouteOverride } from "../../src/index.ts";
import { resolveRoute, SOURCIFY_API_URL } from "../../src/routing/resolve.ts";
import type { Route } from "../../src/routing/resolve.ts";

const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const ADDRESS: Hex = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const SCHEME_MESSAGE = "must use https, or http on localhost, 127.0.0.1 or [::1]";
const DEFAULT_HINT = "Fix the fields listed in details.issues, then call again.";
const BACKEND_HINT = "Leave out route.backend, or name one of: sourcify.";
const NO_CLIENT = "has no client in this version";
const ROUTE_HINT = "Pass route as a plain object with backend and apiUrl fields, or leave it out.";
const API_URL_HINT =
  "Pass an absolute https URL, or an http URL on localhost, 127.0.0.1 or [::1], with no user name, password or fragment.";
const ENDPOINT = "/v2/verify/1/0xabc";

/** Runs `resolveRoute` as this version's flow does, with a Sourcify client only, and returns the error. */
function rejection(chainId: number, override?: unknown): ExplorerVerifyError {
  return thrown(() => resolveRoute(chainId, routeOf(override), { clients: ["sourcify"] }));
}

/** Runs `run` and returns the ExplorerVerifyError it throws. */
function thrown(run: () => unknown): ExplorerVerifyError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ExplorerVerifyError, `threw ${String(error)}`);
    return error;
  }
  return assert.fail("no error thrown");
}

/**
 * Hands an untyped value to `resolveRoute` the way a JavaScript caller would. `Reflect.set` takes
 * an untyped value, so no cast is needed.
 */
function routeOf(value: unknown): RouteOverride | undefined {
  const box: { route?: RouteOverride } = {};
  Reflect.set(box, "route", value);
  return box.route;
}

/** Asserts that `text` appears in none of the places an error can be printed from. */
function assertNotShown(error: ExplorerVerifyError, text: string): void {
  const places = [
    error.message,
    error.hint,
    String(error),
    error.stack ?? "",
    JSON.stringify(error),
    JSON.stringify(error.toJSON()),
    JSON.stringify(error.details),
    String(error.cause),
  ];
  for (const place of places) {
    assert.ok(!place.includes(text), `shown in: ${place.slice(0, 120)}`);
  }
}

/** Asserts an invalid-input error listing exactly `issues`, with no key anywhere in it. */
function assertRejected(
  chainId: number,
  override: unknown,
  issues: { field: string; message: string }[],
): ExplorerVerifyError {
  const error = rejection(chainId, override);
  assert.equal(error.code, "invalid-input");
  assert.equal(error.retryable, false);
  assert.equal(error.cause, undefined);
  if (error.details.code !== "invalid-input") {
    return assert.fail("details do not match the code");
  }
  assert.deepEqual(error.details.issues, issues);
  assert.equal(
    error.message,
    `The route is invalid: ${issues.map((issue) => issue.field).join(", ")}.`,
  );
  assertNotShown(error, DUMMY_KEY);
  return error;
}

/** The explorer link of `route`, failing the test when the route has none. */
function explorerLink(route: Route): (address: Hex) => string {
  return route.explorerUrl ?? assert.fail("the route has no explorer link");
}

describe("resolveRoute: default route (R-RT-2, R-RT-3)", () => {
  for (const chainId of [1, 11155111]) {
    it(`routes chain ${String(chainId)} to Sourcify (R-RT-2)`, () => {
      const route = resolveRoute(chainId);
      assert.equal(route.backend, "sourcify");
      assert.equal(route.apiBase, "https://sourcify.dev/server");
      assert.equal(route.apiBase, SOURCIFY_API_URL);
      assert.equal(route.redactedApiUrl, "https://sourcify.dev/server");
      assert.equal(route.requestUrl(ENDPOINT), `https://sourcify.dev/server${ENDPOINT}`);
    });
  }

  it("resolves a chain id the table does not list only with allowSourcifyFallback (R-RT-3)", () => {
    // 999_999_999 has a row since #60, so the large id here is one below it.
    for (const chainId of [2, 999_999_998, Number.MAX_SAFE_INTEGER]) {
      assert.equal(thrown(() => resolveRoute(chainId)).code, "unsupported-chain");
      const route = resolveRoute(chainId, undefined, { allowSourcifyFallback: true });
      assert.equal(route.backend, "sourcify");
      assert.equal(
        explorerLink(route)(ADDRESS),
        `https://repo.sourcify.dev/${String(chainId)}/${ADDRESS}`,
      );
    }
  });

  it("gives the Sourcify repository page for a contract (R-FLOW-3)", () => {
    const route = resolveRoute(11155111);
    assert.equal(
      explorerLink(route)(ADDRESS),
      "https://repo.sourcify.dev/11155111/0x5FbDB2315678afecb367f032d93F642f64180aa3",
    );
  });

  it("keeps the explorer page on a single path segment for any address string", () => {
    const route = resolveRoute(1);
    assert.equal(
      explorerLink(route)("0x/../../evil?x=1#y"),
      "https://repo.sourcify.dev/1/0x%2F..%2F..%2Fevil%3Fx%3D1%23y",
    );
    // `$` is percent-encoded, so an address cannot form a replacement pattern such as `$&`.
    assert.equal(explorerLink(route)("0x$&$1"), "https://repo.sourcify.dev/1/0x%24%26%241");
  });

  it("returns a plain frozen object with exactly the route fields", () => {
    const route = resolveRoute(1, { apiUrl: "https://sourcify.example.org/server" });
    assert.ok(Object.isFrozen(route));
    assert.equal(Object.getPrototypeOf(route), Object.prototype);
    assert.deepEqual(Object.keys(route).toSorted(), [
      "apiBase",
      "apiKey",
      "backend",
      "explorerUrl",
      "overridden",
      "redactedApiUrl",
      "requestUrl",
      "tableHost",
    ]);
    assert.ok(!("apiUrl" in route));
    assert.equal(Reflect.set(route, "apiBase", "https://evil.example"), false);
    assert.equal(route.apiBase, "https://sourcify.example.org/server");
  });

  it("treats an empty override, and fields set to undefined, as no override (R-RT-2)", () => {
    for (const override of [{}, { backend: undefined, apiUrl: undefined }, undefined]) {
      const route = resolveRoute(1, routeOf(override));
      assert.equal(route.backend, "sourcify");
      assert.equal(route.apiBase, SOURCIFY_API_URL);
      assert.notEqual(route.explorerUrl, undefined);
    }
  });

  it("ignores fields a route override does not have, and does not copy them", () => {
    const route = resolveRoute(1, routeOf({ token: DUMMY_KEY }));
    assert.ok(!JSON.stringify(route).includes(DUMMY_KEY));
    assert.equal(route.apiKey(), undefined);
    assert.equal(route.apiBase, SOURCIFY_API_URL);
  });
});

describe("resolveRoute: override (R-RT-2)", () => {
  it("uses a custom https URL (R-RT-2)", () => {
    const route = resolveRoute(1, { apiUrl: "https://sourcify.example.org/server" });
    assert.equal(route.backend, "sourcify");
    assert.equal(route.apiBase, "https://sourcify.example.org/server");
  });

  it("accepts backend sourcify by name (R-RT-2)", () => {
    const route = resolveRoute(1, { backend: "sourcify" });
    assert.equal(route.backend, "sourcify");
    assert.equal(route.apiBase, SOURCIFY_API_URL);
  });

  it("accepts http://127.0.0.1:8545 (R-RT-2)", () => {
    assert.equal(
      resolveRoute(1, { apiUrl: "http://127.0.0.1:8545" }).apiBase,
      "http://127.0.0.1:8545",
    );
  });

  it("does not follow later changes to the override object", () => {
    const override: RouteOverride = { apiUrl: "https://sourcify.example.org" };
    const route = resolveRoute(1, override);
    override.apiUrl = "https://evil.example";
    assert.equal(route.apiBase, "https://sourcify.example.org");
  });

  // [input, apiBase after normalisation]
  const accepted: [string, string][] = [
    ["https://sourcify.example.org/server/", "https://sourcify.example.org/server"],
    ["https://sourcify.example.org/server///", "https://sourcify.example.org/server"],
    ["https://sourcify.example.org/", "https://sourcify.example.org"],
    ["https://sourcify.example.org", "https://sourcify.example.org"],
    ["https://sourcify.example.org/a/b/", "https://sourcify.example.org/a/b"],
    ["https://sourcify.example.org/server/?a=1", "https://sourcify.example.org/server"],
    ["https://sourcify.example.org:443/server", "https://sourcify.example.org/server"],
    ["https://sourcify.example.org:8443/server", "https://sourcify.example.org:8443/server"],
    ["HTTPS://SOURCIFY.EXAMPLE.ORG/Server", "https://sourcify.example.org/Server"],
    ["https://bücher.example/server", "https://xn--bcher-kva.example/server"],
    ["https://:@sourcify.example.org/server", "https://sourcify.example.org/server"],
    ["  https://sourcify.example.org/server  ", "https://sourcify.example.org/server"],
    ["http://localhost", "http://localhost"],
    ["http://localhost/", "http://localhost"],
    ["http://localhost:5555/server/", "http://localhost:5555/server"],
    ["http://LOCALHOST:5555", "http://localhost:5555"],
    ["HTTP://127.0.0.1:8545/", "http://127.0.0.1:8545"],
    ["http://127.0.0.1:80/server", "http://127.0.0.1/server"],
    ["http://[::1]", "http://[::1]"],
    ["http://[::1]:5555/server", "http://[::1]:5555/server"],
    ["http://[0:0:0:0:0:0:0:1]:5555", "http://[::1]:5555"],
    // The URL parser decodes a percent-encoded host and normalises IPv4 forms, so these are
    // loopback hosts by the time the check runs.
    ["http://%6Cocalhost:5555", "http://localhost:5555"],
    ["http://127.1:5555", "http://127.0.0.1:5555"],
    ["http://0x7f000001:5555", "http://127.0.0.1:5555"],
  ];
  for (const [input, expected] of accepted) {
    it(`accepts ${input.trim()} with the base ${expected} (R-RT-2)`, () => {
      assert.equal(resolveRoute(1, { apiUrl: input }).apiBase, expected);
    });
  }

  it("has no explorer link when the override changes the API base (R-FLOW-3)", () => {
    for (const apiUrl of ["http://127.0.0.1:5555", "https://sourcify.example.org/server"]) {
      assert.equal(resolveRoute(31337, { apiUrl }).explorerUrl, undefined);
    }
  });

  it("keeps the explorer link when the override names the public API base (R-FLOW-3)", () => {
    for (const apiUrl of ["https://sourcify.dev/server/", "https://sourcify.dev/server?a=1"]) {
      assert.equal(
        explorerLink(resolveRoute(1, { apiUrl }))(ADDRESS),
        `https://repo.sourcify.dev/1/${ADDRESS}`,
      );
    }
  });

  it("accepts an apiUrl of 8192 characters", () => {
    const base = "https://sourcify.example.org/";
    const apiUrl = `${base}${"a".repeat(8192 - base.length)}`;
    assert.equal(apiUrl.length, 8192);
    assert.equal(resolveRoute(1, { apiUrl }).apiBase, apiUrl);
  });
});

describe("resolveRoute: loopback hostname match is exact (R-SEC-2)", () => {
  for (const apiUrl of [
    "http://evil.localhost",
    "http://evillocalhost:5555",
    "http://evil.127.0.0.1.example",
    "http://localhostevil",
    "http://a.[::1].example",
  ]) {
    it(`rejects ${apiUrl}`, () => {
      const error = rejection(1, { apiUrl });
      if (error.details.code !== "invalid-input") {
        return assert.fail("details do not match the code");
      }
      assert.deepEqual(
        error.details.issues.map((issue) => issue.field),
        ["route.apiUrl"],
      );
      return undefined;
    });
  }
});

describe("resolveRoute: requestUrl (R-SEC-2)", () => {
  it("appends the endpoint path to the base, then re-adds the caller's query", () => {
    const route = resolveRoute(1, { apiUrl: "https://h.example/server/?apikey=K" });
    assert.equal(route.apiBase, "https://h.example/server");
    assert.equal(route.requestUrl(ENDPOINT), `https://h.example/server${ENDPOINT}?apikey=K`);
  });

  it("adds no query when the caller's URL has none", () => {
    const route = resolveRoute(1, { apiUrl: "https://h.example/server/" });
    assert.equal(route.requestUrl(ENDPOINT), `https://h.example/server${ENDPOINT}`);
  });

  it("treats a bare ? as no query in requestUrl and redactedApiUrl", () => {
    const route = resolveRoute(1, { apiUrl: "https://h.example/server/?" });
    assert.equal(route.requestUrl(ENDPOINT), `https://h.example/server${ENDPOINT}`);
    assert.equal(route.redactedApiUrl, "https://h.example/server");
  });

  it("accepts an empty path, for an API whose base is the endpoint", () => {
    const route = resolveRoute(1, { apiUrl: "https://h.example/api?k=v" });
    assert.equal(route.requestUrl(""), "https://h.example/api?k=v");
  });

  for (const path of ["v2/verify", "?a=1", "/v2/verify?a=1", "/v2#x", "https://evil.example"]) {
    it(`rejects the path ${JSON.stringify(path)}`, () => {
      const route = resolveRoute(1, { apiUrl: `https://h.example/server?k=${DUMMY_KEY}` });
      const error = thrown(() => route.requestUrl(path));
      assert.equal(error.code, "invalid-input");
      assert.deepEqual(error.details, {
        code: "invalid-input",
        issues: [
          { field: "path", message: "must be empty or start with /, and contain no ? or #" },
        ],
      });
      assertNotShown(error, DUMMY_KEY);
    });
  }
});

describe("resolveRoute: rejected API URLs (R-RT-2, R-SEC-2)", () => {
  const schemeOrHost: string[] = [
    "http://example.org",
    "ftp://example.org",
    "http://sourcify.dev/server",
    "http://localhost.evil.com",
    "http://localhost.evil.com:5555",
    "http://127.0.0.1.nip.io",
    "http://evil.com#@localhost",
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:7f00:1]:5555",
    "http://127.0.0.2",
    "http://0.0.0.0",
    "http://10.0.0.1",
    "http://localhost.",
    "http://lоcalhost",
    "http://xn--lcalhost-nbh",
    "ws://localhost",
    "wss://sourcify.example.org",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/plain,hello",
    "blob:https://sourcify.example.org/0",
  ];
  for (const apiUrl of schemeOrHost) {
    it(`rejects ${apiUrl} with invalid-input naming route.apiUrl (R-SEC-2)`, () => {
      const error = assertRejected(1, { apiUrl }, [
        { field: "route.apiUrl", message: SCHEME_MESSAGE },
      ]);
      assert.equal(error.hint, API_URL_HINT);
    });
  }

  for (const apiUrl of ["", "/server", "sourcify.example.org", "https://", "https://exa mple"]) {
    it(`rejects ${JSON.stringify(apiUrl)}, which is not an absolute URL`, () => {
      assertRejected(1, { apiUrl }, [
        { field: "route.apiUrl", message: "must be an absolute URL" },
      ]);
    });
  }

  const notStrings: [string, unknown][] = [
    ["42", 42],
    ["null", null],
    ["{}", {}],
    ["an array", ["https://sourcify.example.org"]],
    ["a URL object", new URL("https://sourcify.example.org")],
    ["a String object", Object("https://sourcify.example.org")],
  ];
  for (const [label, apiUrl] of notStrings) {
    it(`rejects ${label}, which is not a primitive string`, () => {
      assertRejected(1, { apiUrl }, [{ field: "route.apiUrl", message: "must be a string" }]);
    });
  }

  it("rejects an apiUrl longer than 8192 characters before parsing it", () => {
    const apiUrl = `https://sourcify.example.org/${"a".repeat(8192)}?k=${DUMMY_KEY}`;
    const error = assertRejected(1, { apiUrl }, [
      { field: "route.apiUrl", message: "must be at most 8192 characters" },
    ]);
    assert.equal(error.hint, API_URL_HINT);
  });

  const credentials: string[] = [
    `https://${DUMMY_KEY}@sourcify.example.org/server`,
    `https://user:${DUMMY_KEY}@sourcify.example.org/server`,
    `https://:${DUMMY_KEY}@sourcify.example.org/server`,
    `http://${DUMMY_KEY}@localhost:5555`,
  ];
  for (const [index, apiUrl] of credentials.entries()) {
    it(`rejects a URL with a user name or password, case ${String(index)} (R-SEC-2)`, () => {
      assertRejected(1, { apiUrl }, [
        { field: "route.apiUrl", message: "must not contain a user name or password" },
      ]);
    });
  }

  const fragments: string[] = [
    `https://sourcify.example.org/server#${DUMMY_KEY}`,
    "https://sourcify.example.org/server#",
    `http://localhost:5555/#key=${DUMMY_KEY}`,
  ];
  for (const [index, apiUrl] of fragments.entries()) {
    it(`rejects a URL with a fragment, case ${String(index)} (R-SEC-2)`, () => {
      assertRejected(1, { apiUrl }, [
        { field: "route.apiUrl", message: "must not contain a fragment" },
      ]);
    });
  }

  for (const apiUrl of [
    `http://example.org/server?apikey=${DUMMY_KEY}`,
    `ftp://example.org/?${DUMMY_KEY}`,
    `http://${DUMMY_KEY}@example.org`,
    DUMMY_KEY,
  ]) {
    it(`never shows a key from a rejected URL: ${apiUrl.replace(DUMMY_KEY, "<key>")} (R-SEC-2)`, () => {
      const error = rejection(1, { apiUrl });
      assert.equal(error.code, "invalid-input");
      assertNotShown(error, DUMMY_KEY);
    });
  }
});

describe("resolveRoute: query redaction (R-SEC-2)", () => {
  it("keeps the query for requests and redacts it in redactedApiUrl", () => {
    const route = resolveRoute(1, {
      apiUrl: `https://proxy.example.org/server/?apikey=${DUMMY_KEY}&chain=1`,
    });
    assert.equal(route.apiBase, "https://proxy.example.org/server");
    assert.equal(
      route.requestUrl("/v2/x"),
      `https://proxy.example.org/server/v2/x?apikey=${DUMMY_KEY}&chain=1`,
    );
    assert.equal(route.redactedApiUrl, "https://proxy.example.org/server?REDACTED");
    assert.ok(!JSON.stringify(route).includes(DUMMY_KEY));
  });

  it("redacts a query with no value, whose name may itself be a key", () => {
    const route = resolveRoute(1, { apiUrl: `http://localhost:5555/?${DUMMY_KEY}` });
    assert.equal(route.redactedApiUrl, "http://localhost:5555?REDACTED");
  });

  it("leaves a URL with no query unchanged in redactedApiUrl", () => {
    const route = resolveRoute(1, { apiUrl: "https://sourcify.example.org/server/" });
    assert.equal(route.redactedApiUrl, "https://sourcify.example.org/server");
  });
});

describe("resolveRoute: backend (R-RT-2)", () => {
  for (const backend of ["etherscan-v2", "etherscan-compatible", "blockscout", "routescan"]) {
    it(`rejects ${backend}, which has no client in this version (R-RT-2)`, () => {
      const error = assertRejected(1, { backend }, [
        { field: "route.backend", message: NO_CLIENT },
      ]);
      assert.equal(error.hint, BACKEND_HINT);
    });
  }

  const unknown: [string, unknown][] = [
    ['"etherscan"', "etherscan"],
    ['"Sourcify"', "Sourcify"],
    ['""', ""],
    ["<key>", DUMMY_KEY],
    ["1", 1],
    ["null", null],
    ['["sourcify"]', ["sourcify"]],
    ['Object("sourcify")', Object("sourcify")],
  ];
  for (const [label, backend] of unknown) {
    it(`rejects the unknown backend ${label} without repeating it, with the backend hint (R-RT-2)`, () => {
      const error = assertRejected(1, { backend }, [
        { field: "route.backend", message: "must name a known backend" },
      ]);
      assert.equal(error.hint, BACKEND_HINT);
    });
  }

  it("lists a backend and an apiUrl problem together, with the backend hint", () => {
    const error = assertRejected(1, { backend: "blockscout", apiUrl: "ftp://example.org" }, [
      { field: "route.backend", message: NO_CLIENT },
      { field: "route.apiUrl", message: SCHEME_MESSAGE },
    ]);
    assert.equal(error.hint, BACKEND_HINT);
  });
});

describe("resolveRoute: plain object only", () => {
  class Options {
    apiUrl = "https://sourcify.example.org";
  }
  const notPlain: [string, unknown][] = [
    ["a string", "https://sourcify.example.org"],
    ["a number", 1],
    ["null", null],
    ["an empty array", []],
    ["an array", [{ apiUrl: "x" }]],
    ["a function", Object.assign(() => undefined, { apiUrl: "https://sourcify.example.org" })],
    ["a Date", new Date(0)],
    ["a Map", new Map([["apiUrl", "https://sourcify.example.org"]])],
    ["a class instance", new Options()],
    ["an object with a custom prototype", Object.create({ apiUrl: "http://evil.example" })],
  ];
  for (const [label, override] of notPlain) {
    it(`rejects ${label} as the route, with the route hint`, () => {
      const error = assertRejected(1, override, [
        { field: "route", message: "must be a plain object" },
      ]);
      assert.equal(error.hint, ROUTE_HINT);
    });
  }

  it("accepts an object with a null prototype", () => {
    const override: unknown = Object.assign(Object.create(null), {
      apiUrl: "https://sourcify.example.org",
    });
    assert.equal(resolveRoute(1, routeOf(override)).apiBase, "https://sourcify.example.org");
  });

  it("ignores an apiUrl inherited through a polluted Object.prototype", () => {
    Reflect.set(Object.prototype, "apiUrl", "http://evil.example");
    Reflect.set(Object.prototype, "backend", "blockscout");
    try {
      const route = resolveRoute(1, {});
      assert.equal(route.apiBase, SOURCIFY_API_URL);
      assert.equal(route.backend, "sourcify");
    } finally {
      Reflect.deleteProperty(Object.prototype, "apiUrl");
      Reflect.deleteProperty(Object.prototype, "backend");
    }
  });

  it("reads each override field exactly once", () => {
    const reads = { apiUrl: 0, backend: 0 };
    const override = {
      get apiUrl(): string {
        reads.apiUrl++;
        return reads.apiUrl === 1 ? "https://sourcify.example.org/a" : "http://evil.example";
      },
      get backend(): string {
        reads.backend++;
        return reads.backend === 1 ? "sourcify" : "blockscout";
      },
    };
    const route = resolveRoute(1, routeOf(override));
    assert.deepEqual(reads, { apiUrl: 1, backend: 1 });
    assert.equal(route.apiBase, "https://sourcify.example.org/a");
    assert.equal(route.backend, "sourcify");
  });

  it("rejects a route whose fields throw when read, without the raw error", () => {
    const hostile = new Proxy(
      { apiUrl: "https://sourcify.example.org" },
      {
        get() {
          throw new Error(DUMMY_KEY);
        },
      },
    );
    assertRejected(1, hostile, [{ field: "route", message: "must be a plain object" }]);
  });

  it("rejects a revoked Proxy as the route", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    assertRejected(1, proxy, [{ field: "route", message: "must be a plain object" }]);
  });
});

describe("resolveRoute: chain id", () => {
  for (const chainId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    it(`rejects the chain id ${String(chainId)}, with the default hint`, () => {
      const error = assertRejected(chainId, undefined, [
        { field: "chainId", message: "must be a positive integer" },
      ]);
      assert.equal(error.hint, DEFAULT_HINT);
    });
  }

  it("lists a bad chain id and a bad route together, in that order", () => {
    assertRejected(0, { apiUrl: "ftp://example.org" }, [
      { field: "chainId", message: "must be a positive integer" },
      { field: "route.apiUrl", message: SCHEME_MESSAGE },
    ]);
  });
});
