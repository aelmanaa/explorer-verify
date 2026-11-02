import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError } from "../../src/index.ts";
import type { Hex, RouteOverride } from "../../src/index.ts";
import { resolveRoute, SOURCIFY_API_URL } from "../../src/routing/resolve.ts";

const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const ADDRESS: Hex = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const SCHEME_MESSAGE = "must use https, or http on localhost, 127.0.0.1 or [::1]";
const BACKEND_HINT = "Only sourcify is available in this version. Remove route.backend.";
const API_URL_HINT =
  "Pass an absolute https URL, or an http URL on localhost, 127.0.0.1 or [::1], with no user name, password or fragment.";

/** Runs `resolveRoute` and returns the error it throws. */
function rejection(chainId: number, override?: unknown): ExplorerVerifyError {
  // `override` is `unknown` so the tests can pass what a JavaScript caller could pass.
  const route: unknown = override;
  try {
    resolveRoute(chainId, routeOf(route));
  } catch (error) {
    assert.ok(error instanceof ExplorerVerifyError, `resolveRoute threw ${String(error)}`);
    return error;
  }
  return assert.fail("resolveRoute accepted the route");
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

describe("resolveRoute: default route (R-RT-2, R-RT-3)", () => {
  for (const chainId of [1, 11155111]) {
    it(`routes chain ${String(chainId)} to Sourcify (R-RT-2)`, () => {
      const route = resolveRoute(chainId);
      assert.equal(route.backend, "sourcify");
      assert.equal(route.apiUrl, "https://sourcify.dev/server");
      assert.equal(route.apiUrl, SOURCIFY_API_URL);
      assert.equal(route.redactedApiUrl, "https://sourcify.dev/server");
    });
  }

  it("resolves a chain id no table lists, because M1 routes every chain to Sourcify (R-RT-3)", () => {
    for (const chainId of [2, 999_999_999, Number.MAX_SAFE_INTEGER]) {
      assert.equal(resolveRoute(chainId).backend, "sourcify");
    }
  });

  it("gives the Sourcify repository page for a contract (R-FLOW-3)", () => {
    const route = resolveRoute(11155111);
    assert.equal(
      route.explorerUrl(11155111, ADDRESS),
      "https://repo.sourcify.dev/11155111/0x5FbDB2315678afecb367f032d93F642f64180aa3",
    );
  });

  it("keeps the explorer page on a single path segment for any address string", () => {
    const route = resolveRoute(1);
    assert.equal(
      route.explorerUrl(1, "0x/../../evil?x=1#y"),
      "https://repo.sourcify.dev/1/0x%2F..%2F..%2Fevil%3Fx%3D1%23y",
    );
  });

  it("returns a plain frozen object with exactly the route fields", () => {
    const route = resolveRoute(1, { apiUrl: "https://sourcify.example.org/server" });
    assert.ok(Object.isFrozen(route));
    assert.equal(Object.getPrototypeOf(route), Object.prototype);
    assert.deepEqual(Object.keys(route).toSorted(), [
      "apiUrl",
      "backend",
      "explorerUrl",
      "redactedApiUrl",
    ]);
    assert.equal(Reflect.set(route, "apiUrl", "https://evil.example"), false);
    assert.equal(route.apiUrl, "https://sourcify.example.org/server");
  });

  it("treats an empty override, and fields set to undefined, as no override (R-RT-2)", () => {
    for (const override of [{}, { backend: undefined, apiUrl: undefined }, undefined]) {
      const route = resolveRoute(1, routeOf(override));
      assert.equal(route.backend, "sourcify");
      assert.equal(route.apiUrl, SOURCIFY_API_URL);
    }
  });

  it("ignores fields a route override does not have, and does not copy them", () => {
    const route = resolveRoute(1, routeOf({ apiKey: DUMMY_KEY }));
    assert.ok(!JSON.stringify(route).includes(DUMMY_KEY));
    assert.equal(route.apiUrl, SOURCIFY_API_URL);
  });
});

describe("resolveRoute: override (R-RT-2)", () => {
  it("uses a custom https URL (R-RT-2)", () => {
    const route = resolveRoute(1, { apiUrl: "https://sourcify.example.org/server" });
    assert.equal(route.backend, "sourcify");
    assert.equal(route.apiUrl, "https://sourcify.example.org/server");
  });

  it("accepts backend sourcify by name (R-RT-2)", () => {
    const route = resolveRoute(1, { backend: "sourcify" });
    assert.equal(route.backend, "sourcify");
    assert.equal(route.apiUrl, SOURCIFY_API_URL);
  });

  it("accepts http://127.0.0.1:8545 (R-RT-2)", () => {
    assert.equal(
      resolveRoute(1, { apiUrl: "http://127.0.0.1:8545" }).apiUrl,
      "http://127.0.0.1:8545",
    );
  });

  it("does not follow later changes to the override object", () => {
    const override: RouteOverride = { apiUrl: "https://sourcify.example.org" };
    const route = resolveRoute(1, override);
    override.apiUrl = "https://evil.example";
    assert.equal(route.apiUrl, "https://sourcify.example.org");
  });

  // [input, apiUrl after normalisation]
  const accepted: [string, string][] = [
    ["https://sourcify.example.org/server/", "https://sourcify.example.org/server"],
    ["https://sourcify.example.org/server///", "https://sourcify.example.org/server"],
    ["https://sourcify.example.org/", "https://sourcify.example.org"],
    ["https://sourcify.example.org", "https://sourcify.example.org"],
    ["https://sourcify.example.org/a/b/", "https://sourcify.example.org/a/b"],
    ["https://sourcify.example.org/server/?", "https://sourcify.example.org/server"],
    ["https://sourcify.example.org/server/?a=1", "https://sourcify.example.org/server?a=1"],
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
    it(`accepts ${input.trim()} as ${expected} (R-RT-2)`, () => {
      assert.equal(resolveRoute(1, { apiUrl: input }).apiUrl, expected);
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

  for (const apiUrl of [42, null, {}, ["https://sourcify.example.org"]]) {
    it(`rejects ${JSON.stringify(apiUrl)}, which is not a string`, () => {
      assertRejected(1, { apiUrl }, [{ field: "route.apiUrl", message: "must be a string" }]);
    });
  }

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
  it("keeps the query in apiUrl for requests and redacts it in redactedApiUrl", () => {
    const route = resolveRoute(1, {
      apiUrl: `https://proxy.example.org/server/?apikey=${DUMMY_KEY}&chain=1`,
    });
    assert.equal(route.apiUrl, `https://proxy.example.org/server?apikey=${DUMMY_KEY}&chain=1`);
    assert.equal(route.redactedApiUrl, "https://proxy.example.org/server?REDACTED");
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
    it(`rejects ${backend}, because only sourcify is available in M1 (R-RT-2)`, () => {
      const error = assertRejected(1, { backend }, [
        {
          field: "route.backend",
          message: "must be sourcify; only sourcify is available in this version",
        },
      ]);
      assert.equal(error.hint, BACKEND_HINT);
    });
  }

  for (const backend of ["etherscan", "Sourcify", "", DUMMY_KEY, 1, null]) {
    const shown = backend === DUMMY_KEY ? "<key>" : JSON.stringify(backend);
    it(`rejects the unknown backend ${shown} without repeating it (R-RT-2)`, () => {
      assertRejected(1, { backend }, [
        { field: "route.backend", message: "must name a known backend" },
      ]);
    });
  }

  it("lists a backend and an apiUrl problem together, with the backend hint", () => {
    const error = assertRejected(1, { backend: "blockscout", apiUrl: "ftp://example.org" }, [
      {
        field: "route.backend",
        message: "must be sourcify; only sourcify is available in this version",
      },
      { field: "route.apiUrl", message: SCHEME_MESSAGE },
    ]);
    assert.equal(error.hint, BACKEND_HINT);
  });
});

describe("resolveRoute: malformed input", () => {
  for (const override of ["https://sourcify.example.org", 1, null, [], [{ apiUrl: "x" }]]) {
    it(`rejects the route ${JSON.stringify(override)}, which is not a plain object`, () => {
      assertRejected(1, override, [{ field: "route", message: "must be a plain object" }]);
    });
  }

  it("rejects a route whose fields throw when read, without the raw error", () => {
    const hostile = new Proxy(
      {},
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

  for (const chainId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    it(`rejects the chain id ${String(chainId)}`, () => {
      const error = assertRejected(chainId, undefined, [
        { field: "chainId", message: "must be a positive integer" },
      ]);
      assert.equal(error.hint, "Fix the fields listed in details.issues, then call again.");
    });
  }

  it("lists a bad chain id and a bad route together, in that order", () => {
    assertRejected(0, { apiUrl: "ftp://example.org" }, [
      { field: "chainId", message: "must be a positive integer" },
      { field: "route.apiUrl", message: SCHEME_MESSAGE },
    ]);
  });
});
