// Black-box tests for issue #15: minimal routing. They use only the declarations of
// routing/resolve.ts, the RouteOverride TSDoc, the issue, requirements R-RT-2, R-RT-3, R-SEC-2,
// R-BE-4 and the "Routing" section of architecture.md. Cases that resolve-route.test.ts
// already covers are left out. Since the routing table (#59), a chain the table does not list
// reaches Sourcify only with allowSourcifyFallback, and route.backend is checked against the
// backends with a client, which these tests pass as `clients`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import { BACKEND_NAMES } from "../../src/backend-names.ts";
import type { BackendName } from "../../src/backend-names.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { SOURCIFY_API_URL, resolveRoute } from "../../src/routing/resolve.ts";
import type { Route } from "../../src/routing/resolve.ts";
import type { Hex, RouteOverride } from "../../src/types.ts";

const ADDRESS: Hex = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const DUMMY_KEY = "DUMMYKEYzq9x7w5v3u1t";

function catchError(run: () => void): ExplorerVerifyError {
  let caught: unknown;
  let threw = false;
  try {
    run();
  } catch (error) {
    caught = error;
    threw = true;
  }
  assert.ok(threw, "expected a throw");
  assert.ok(caught instanceof ExplorerVerifyError, "expected ExplorerVerifyError");
  return caught;
}

// Calls resolveRoute with values its signature does not allow, without a cast.
function callUntyped(chainId: unknown, override?: unknown): void {
  Reflect.apply(resolveRoute, undefined, [chainId, override]);
}

function expectInvalid(run: () => void, field: string): ExplorerVerifyError {
  const error = catchError(run);
  assert.equal(error.code, "invalid-input");
  assert.equal(error.details.code, "invalid-input");
  if (error.details.code === "invalid-input") {
    const fields = error.details.issues.map((issue) => issue.field);
    assert.ok(fields.includes(field), `expected an issue for ${field}, got ${fields.join(", ")}`);
    for (const issue of error.details.issues) {
      assert.ok(issue.message.length > 0);
    }
  }
  return error;
}

function surfaces(error: ExplorerVerifyError): Array<[string, string]> {
  return [
    ["message", error.message],
    ["hint", error.hint],
    ["toJSON", JSON.stringify(error.toJSON())],
    ["JSON.stringify", JSON.stringify(error)],
    ["String", String(error)],
    ["stack", error.stack ?? ""],
    ["details", JSON.stringify(error.details)],
    ["inspect", inspect(error, { depth: 10 })],
  ];
}

describe("blackbox #15: default route (R-RT-2, R-BE-4)", () => {
  for (const chainId of [10, 137, 8453, 31337]) {
    it(`routes chain ${String(chainId)} to public Sourcify with allowSourcifyFallback (R-RT-3)`, () => {
      const route = resolveRoute(chainId, undefined, { allowSourcifyFallback: true });
      assert.equal(route.backend, "sourcify");
      assert.equal(route.apiBase, SOURCIFY_API_URL);
      assert.equal(route.redactedApiUrl, SOURCIFY_API_URL);
      assert.equal(
        route.requestUrl(`/v2/contract/${String(chainId)}/${ADDRESS}`),
        `https://sourcify.dev/server/v2/contract/${String(chainId)}/${ADDRESS}`,
      );
    });
  }

  it("accepts undefined fields and an undefined override from an untyped caller", () => {
    assert.doesNotThrow(() => callUntyped(1, { backend: undefined, apiUrl: undefined }));
    assert.doesNotThrow(() => callUntyped(1, undefined));
  });
});

describe("blackbox #15: explorer page (R-FLOW-3)", () => {
  it("keeps the address case", () => {
    const explorerUrl = resolveRoute(1).explorerUrl;
    assert.notEqual(explorerUrl, undefined);
    assert.equal(
      explorerUrl?.(ADDRESS),
      "https://repo.sourcify.dev/1/0x5FbDB2315678afecb367f032d93F642f64180aa3",
    );
  });

  it("has no public page when apiUrl points at a local server (TSDoc example)", () => {
    const route = resolveRoute(31337, { apiUrl: "http://127.0.0.1:5555/" });
    assert.equal(route.explorerUrl, undefined);
  });
});

describe("blackbox #15: override accepted (R-RT-2)", () => {
  const accepted: Array<[string, string]> = [
    ["https://sourcify.example.org:8443/a/b", "https://sourcify.example.org:8443/a/b"],
    ["http://127.0.0.1:5555/", "http://127.0.0.1:5555"],
  ];
  for (const [input, expected] of accepted) {
    it(`accepts ${input}`, () => {
      const route = resolveRoute(1, { apiUrl: input });
      assert.equal(route.backend, "sourcify");
      assert.equal(route.apiBase, expected);
      assert.equal(route.redactedApiUrl, expected);
      assert.equal(route.requestUrl("/v2/x"), `${expected}/v2/x`);
    });
  }

  it("ignores fields other than backend and apiUrl", () => {
    const override = { apiUrl: "https://sourcify.example.org/server", extra: "x" };
    const route = resolveRoute(1, override);
    assert.equal(route.apiBase, "https://sourcify.example.org/server");
  });

  it("lowercases scheme and host and keeps path case, before a query", () => {
    const route = resolveRoute(1, { apiUrl: "HTTPS://Sourcify.Example.ORG/Server/?a=1" });
    assert.equal(route.apiBase, "https://sourcify.example.org/Server");
    assert.equal(route.requestUrl("/v2/x"), "https://sourcify.example.org/Server/v2/x?a=1");
  });
});

describe("blackbox #15: redactedApiUrl (R-SEC-1)", () => {
  it("redacts a query with several parameters on a loopback URL", () => {
    const route = resolveRoute(1, { apiUrl: `http://localhost:5555/?x=1&key=${DUMMY_KEY}` });
    assert.equal(route.redactedApiUrl, "http://localhost:5555?REDACTED");
    assert.equal(route.apiBase, "http://localhost:5555");
    assert.ok(!route.redactedApiUrl.includes(DUMMY_KEY));
    assert.ok(!route.apiBase.includes(DUMMY_KEY));
  });
});

describe("blackbox #15: override rejected (R-SEC-2)", () => {
  const rejected = [
    "http://sourcify.example.org/server",
    "https://user:pass@sourcify.example.org",
    "https://user@sourcify.example.org",
    "https://:pass@sourcify.example.org",
    "http://user@localhost:5555",
    "not a url",
  ];
  for (const apiUrl of rejected) {
    it(`rejects ${JSON.stringify(apiUrl)} naming route.apiUrl`, () => {
      expectInvalid(() => resolveRoute(1, { apiUrl }), "route.apiUrl");
    });
  }

  const otherBackends: BackendName[] = BACKEND_NAMES.filter((name) => name !== "sourcify");
  for (const backend of otherBackends) {
    it(`names sourcify when it rejects backend ${backend}`, () => {
      const error = expectInvalid(
        () => resolveRoute(1, { backend }, { clients: ["sourcify"] }),
        "route.backend",
      );
      assert.match(`${error.message} ${error.hint}`.toLowerCase(), /sourcify/);
    });
  }

  it("rejects true as the override naming route", () => {
    expectInvalid(() => callUntyped(1, true), "route");
  });

  for (const [label, value] of [
    ["the string 1", "1"],
    ["undefined", undefined],
  ] as const) {
    it(`rejects chainId ${label}`, () => {
      expectInvalid(() => callUntyped(value), "chainId");
    });
  }
});

describe("blackbox #15: frozen result, independent of the input", () => {
  it("cannot be redefined", () => {
    const route = resolveRoute(1, { apiUrl: "https://sourcify.example.org/server" });
    assert.throws(() => {
      Object.defineProperty(route, "apiBase", { value: "https://evil.example.org" });
    }, TypeError);
    assert.equal(route.apiBase, "https://sourcify.example.org/server");
  });

  it("does not change when both override fields change later", () => {
    const override: RouteOverride = {
      backend: "sourcify",
      apiUrl: "https://sourcify.example.org/a",
    };
    const route: Route = resolveRoute(1, override);
    override.apiUrl = "http://example.org";
    override.backend = "etherscan-v2";
    assert.equal(route.apiBase, "https://sourcify.example.org/a");
    assert.equal(route.backend, "sourcify");
  });

  it("uses the value it validated when a getter changes between reads", () => {
    let reads = 0;
    const override = {
      get apiUrl(): string {
        reads += 1;
        return reads === 1 ? "https://sourcify.example.org/a" : "http://evil.example.org";
      },
    };
    const route = resolveRoute(1, override);
    assert.equal(route.apiBase, "https://sourcify.example.org/a");
    assert.equal(route.requestUrl("/v2/x"), "https://sourcify.example.org/a/v2/x");
  });
});

describe("blackbox #15: a key in the URL never reaches an error (R-SEC-1, R-SEC-2)", () => {
  const cases: Array<[string, () => void]> = [
    [
      "userinfo name",
      () => resolveRoute(1, { apiUrl: `https://${DUMMY_KEY}@sourcify.example.org` }),
    ],
    [
      "userinfo password",
      () => resolveRoute(1, { apiUrl: `https://u:${DUMMY_KEY}@sourcify.example.org` }),
    ],
    [
      "query of an http URL",
      () => resolveRoute(1, { apiUrl: `http://example.org/?apikey=${DUMMY_KEY}` }),
    ],
    ["fragment", () => resolveRoute(1, { apiUrl: `https://sourcify.example.org/#${DUMMY_KEY}` })],
    ["unparseable URL", () => resolveRoute(1, { apiUrl: `not a url ${DUMMY_KEY}` })],
    ["ftp URL with query", () => resolveRoute(1, { apiUrl: `ftp://example.org/?k=${DUMMY_KEY}` })],
    ["unknown backend", () => callUntyped(1, { backend: DUMMY_KEY })],
    ["string override", () => callUntyped(1, DUMMY_KEY)],
    ["string chainId", () => callUntyped(DUMMY_KEY)],
    [
      "request path on a route with a key in the query",
      () => resolveRoute(1, { apiUrl: `https://h.example/?k=${DUMMY_KEY}` }).requestUrl("x"),
    ],
  ];
  for (const [label, run] of cases) {
    it(`hides the key, inspect included: ${label}`, () => {
      const error = catchError(run);
      assert.equal(error.code, "invalid-input");
      for (const [surface, text] of surfaces(error)) {
        assert.ok(!text.includes(DUMMY_KEY), `the key leaked into ${surface}`);
      }
      assert.equal(error.cause, undefined, "the error must have no cause");
    });
  }
});
