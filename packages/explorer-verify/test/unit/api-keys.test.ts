// Tests for API keys (R-SEC-1, R-SEC-2, R-AX-7, R-SRV-5, decision 0016): which options are
// accepted, which request gets a key, where in the request it goes, and what an explorer's answer
// about a key means. Requests go through the HTTP layer to a fake fetch that replays the answers
// recorded live on 2026-11-03.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKEND_NAMES } from "../../src/backend-names.ts";
import type { BackendName } from "../../src/backend-names.ts";
import type { Backend } from "../../src/backends/backend.ts";
import { ERROR_EXIT_CODES, ExplorerVerifyError } from "../../src/errors.ts";
import type { ErrorCode } from "../../src/errors.ts";
import { runCheckStatus } from "../../src/flow/status.ts";
import { openCall, settingsOf } from "../../src/flow/verify.ts";
import {
  MAX_KEY_LENGTH,
  checkKey,
  keyErrorOf,
  keyFor,
  readApiKeys,
  requireKey,
  checkRouteKey,
  withKey,
} from "../../src/http/api-keys.ts";
import type { ApiKeys, KeyContext } from "../../src/http/api-keys.ts";
import { request } from "../../src/http/fetch.ts";
import type { HttpRequest } from "../../src/http/fetch.ts";
import type { Route } from "../../src/routing/resolve.ts";
import type { RouteOverride, VerifyOptions } from "../../src/types.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import type { Call, Fixture } from "../helpers/fake-fetch.ts";
import { resolveRoute } from "../helpers/route.ts";

// Made-up keys. Never real ones (R-SEC-1).
const ETHERSCAN_KEY = "etherscan-dummy-key-58a1";
const ROUTESCAN_KEY = "routescan-dummy-key-58b2";
const STANDALONE_KEY = "standalone-dummy-key-58c3";
const ETHERSCAN_API = "https://api.etherscan.io/v2/api";
const ETHERSCAN_URL = `${ETHERSCAN_API}?chainid=421614`;
const ROUTESCAN_API = "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api";
const STANDALONE_API = "https://explorer.example.org/api";
const ADDRESS = "0xF20cfae8007a1e2df9A7CBa74bD54A375e1771c4";
const GUID = "9qaexazfu55fthj5fdjzpk47v1hkbz1p2ywcn4qqdcbyyhtr5i";
const KEYS = { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY };

// The routing table's API host of each keyed backend (#59).
const TABLE_HOSTS: Readonly<Partial<Record<BackendName, string>>> = {
  "etherscan-v2": "api.etherscan.io",
  routescan: "api.routescan.io",
};

/**
 * A route as the routing table or an override would resolve it: on the table's host it is the
 * table's route, anywhere else it is overridden, as `route.apiUrl` makes it.
 */
function routeOf(backend: BackendName, apiBase: string, apiKey?: string): Route {
  const tableHost = TABLE_HOSTS[backend];
  return {
    backend,
    apiBase,
    redactedApiUrl: apiBase,
    requestUrl: (path: string): string => `${apiBase}${path}`,
    explorerUrl: undefined,
    apiKey: () => apiKey,
    overridden: tableHost === undefined || !apiBase.startsWith(`https://${tableHost}/`),
    tableHost,
    routedBy: "api-url",
    skipped: [],
  };
}

function keyed(route: Route, apiKeys: ApiKeys = KEYS): KeyContext {
  return { route, apiKeys: () => apiKeys };
}

function etherscan(name: string): Fixture {
  return loadFixture("etherscan", `2026-11-03-${name}`);
}

/** An Etherscan v2 form POST without a key, as a client builds it. */
function etherscanForm(fields: Record<string, string>): HttpRequest {
  return {
    url: ETHERSCAN_URL,
    method: "POST",
    body: new URLSearchParams({ module: "contract", ...fields }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    retry: "safe",
  };
}

/** Sends `req` through the HTTP layer to a fake fetch that answers `fixture`. */
async function sendTo(
  backend: BackendName,
  req: HttpRequest,
  fixture: Fixture,
  secrets: readonly string[] = [ETHERSCAN_KEY, ROUTESCAN_KEY],
): Promise<{ body: unknown; call: Call }> {
  const fake = replay(fixture);
  const response = await request({ backend, fetch: fake.fetch, secrets }, req);
  const body: unknown = await response.json();
  const [call] = fake.calls;
  assert.ok(call !== undefined);
  return { body, call };
}

/** Every place a key could show in a sent request, as one string. */
function everythingSent(call: Call): string {
  return JSON.stringify([call.url, call.body, [...call.headers.entries()]]);
}

function thrown(run: () => unknown): ExplorerVerifyError {
  let caught: unknown;
  try {
    run();
  } catch (error: unknown) {
    caught = error;
  }
  assert.ok(
    caught instanceof ExplorerVerifyError,
    `expected an ExplorerVerifyError: ${String(caught)}`,
  );
  return caught;
}

/** Etherscan's answer to a getsourcecode request that carries the key from apiKeys. */
async function answerOf(name: string): Promise<unknown> {
  const ctx = keyed(routeOf("etherscan-v2", ETHERSCAN_API));
  const req = withKey(
    ctx,
    "etherscan-v2",
    etherscanForm({ action: "getsourcecode", address: ADDRESS }),
  );
  return (await sendTo("etherscan-v2", req, etherscan(name))).body;
}

/** The error settingsOf throws for options built from `fields`, of any type. */
function optionsError(fields: Readonly<Record<string, unknown>>): ExplorerVerifyError {
  const options: VerifyOptions = {};
  for (const [name, value] of Object.entries(fields)) {
    Reflect.set(options, name, value);
  }
  return thrown(() => settingsOf(options));
}

function assertKeyError(error: ExplorerVerifyError | undefined, code: ErrorCode): void {
  assert.ok(error !== undefined, `expected ${code}`);
  assert.equal(error.code, code);
  assert.deepEqual(error.details, { code, backend: "etherscan-v2" });
  assert.equal(ERROR_EXIT_CODES[error.code], 3);
  assert.equal(error.retryable, false);
  assert.ok(!JSON.stringify([error.message, error.toJSON()]).includes(ETHERSCAN_KEY));
}

describe("keyFor: the one attachment rule (R-SEC-2)", () => {
  it("attaches the Etherscan key only to api.etherscan.io (R-SEC-2)", () => {
    const ctx = keyed(routeOf("etherscan-v2", ETHERSCAN_API));
    assert.equal(keyFor(ctx, "etherscan-v2", ETHERSCAN_URL), ETHERSCAN_KEY);
    assert.equal(keyFor(ctx, "etherscan-v2", "https://API.Etherscan.IO/v2/api"), ETHERSCAN_KEY);
    for (const [apiBase, url] of [
      ["http://api.etherscan.io/v2/api", "http://api.etherscan.io/v2/api?chainid=1"],
      ["https://api.etherscan.io:8443/v2/api", "https://api.etherscan.io:8443/v2/api"],
      ["https://api.etherscan.io.evil.example/v2/api", "https://api.etherscan.io.evil.example/x"],
      ["https://etherscan.io/v2/api", "https://etherscan.io/v2/api"],
      ["http://127.0.0.1:5555", "http://127.0.0.1:5555/v2/api"],
    ] as const) {
      assert.equal(keyFor(keyed(routeOf("etherscan-v2", apiBase)), "etherscan-v2", url), undefined);
    }
    // The same host, but from the caller's route.apiUrl: no key from apiKeys (#59).
    const named = keyed({ ...routeOf("etherscan-v2", ETHERSCAN_API), overridden: true });
    assert.equal(keyFor(named, "etherscan-v2", ETHERSCAN_URL), undefined);
  });

  it("does not attach a key to an overridden apiUrl on another host (R-SEC-2)", async () => {
    const ctx = keyed(routeOf("etherscan-v2", "https://attacker.example/api"));
    const req = { ...etherscanForm({ action: "getsourcecode", address: ADDRESS }) };
    const moved = { ...req, url: "https://attacker.example/api?chainid=421614" };
    assert.equal(keyFor(ctx, "etherscan-v2", moved.url), undefined);
    assert.equal(withKey(ctx, "etherscan-v2", moved), moved);
    const { call } = await sendTo(
      "etherscan-v2",
      withKey(ctx, "etherscan-v2", moved),
      etherscan("getsourcecode-no-key"),
    );
    assert.ok(!everythingSent(call).includes(ETHERSCAN_KEY));
  });

  it("does not attach a key to a URL off the route, even on the table host (R-SEC-2)", () => {
    const ctx = keyed(routeOf("etherscan-v2", "https://attacker.example/api"));
    assert.equal(keyFor(ctx, "etherscan-v2", ETHERSCAN_URL), undefined);
    const own = keyed(routeOf("etherscan-v2", ETHERSCAN_API));
    assert.equal(keyFor(own, "etherscan-v2", "https://attacker.example/api"), undefined);
    assert.equal(keyFor(own, "etherscan-v2", "not a url"), undefined);
  });

  it("does not attach a key when handle.backend differs from the routed backend (R-SEC-2, #18)", () => {
    // A handle that names etherscan-v2 on a chain routed to Routescan, and the other way round.
    // Every URL is on the route's own host, so only the backend argument decides.
    const routescan = keyed(routeOf("routescan", ROUTESCAN_API));
    assert.equal(keyFor(routescan, "routescan", ROUTESCAN_API), ROUTESCAN_KEY);
    assert.equal(keyFor(routescan, "etherscan-v2", ROUTESCAN_API), undefined);
    const ether = keyed(routeOf("etherscan-v2", ETHERSCAN_API));
    assert.equal(keyFor(ether, "etherscan-v2", ETHERSCAN_URL), ETHERSCAN_KEY);
    assert.equal(keyFor(ether, "routescan", ETHERSCAN_URL), undefined);
    const sourcify = keyed(resolveRoute(421614));
    assert.equal(keyFor(sourcify, "etherscan-v2", sourcify.route.apiBase), undefined);
    const req = {
      ...etherscanForm({ action: "checkverifystatus", guid: GUID }),
      url: ROUTESCAN_API,
    };
    assert.equal(withKey(routescan, "etherscan-v2", req), req);
  });

  it("refuses a handle whose backend is not the route's before any request (R-SEC-2, #18)", async () => {
    const fake = replay();
    const handle = {
      version: 1,
      backend: "etherscan-v2",
      chainId: 421614,
      address: ADDRESS,
      jobId: GUID,
    };
    let outcome: unknown;
    try {
      // Chain 421614 lists etherscan-v2 first (#122); route.backend picks its Sourcify entry.
      await runCheckStatus(
        handle,
        { fetch: fake.fetch, apiKeys: KEYS, route: { backend: "sourcify" } },
        { backends: {} },
      );
    } catch (error: unknown) {
      outcome = error;
    }
    assert.ok(outcome instanceof ExplorerVerifyError);
    assert.equal(outcome.code, "invalid-input");
    assert.equal(fake.calls.length, 0);
    assert.ok(!JSON.stringify([outcome.message, outcome.toJSON()]).includes(ETHERSCAN_KEY));
  });

  it("binds route.apiKey to the route's host and backend, and lets it win over apiKeys (R-SEC-2)", () => {
    const standalone = keyed(routeOf("etherscan-compatible", STANDALONE_API, STANDALONE_KEY), KEYS);
    assert.equal(
      keyFor(standalone, "etherscan-compatible", `${STANDALONE_API}?chainid=1`),
      STANDALONE_KEY,
    );
    assert.equal(keyFor(standalone, "etherscan-compatible", ETHERSCAN_URL), undefined);
    assert.equal(keyFor(standalone, "etherscan-v2", `${STANDALONE_API}?chainid=1`), undefined);
    const ether = keyed(routeOf("etherscan-v2", ETHERSCAN_API, STANDALONE_KEY));
    assert.equal(keyFor(ether, "etherscan-v2", ETHERSCAN_URL), STANDALONE_KEY);
  });

  it("gives no key when apiKeys is absent or lacks the backend (R-SEC-2)", () => {
    const route = routeOf("etherscan-v2", ETHERSCAN_API);
    assert.equal(keyFor({ route }, "etherscan-v2", ETHERSCAN_URL), undefined);
    assert.equal(keyFor(keyed(route, {}), "etherscan-v2", ETHERSCAN_URL), undefined);
    // A standalone route without route.apiKey has no table host, so apiKeys never applies.
    const standalone = keyed(routeOf("etherscan-compatible", STANDALONE_API));
    assert.equal(keyFor(standalone, "etherscan-compatible", STANDALONE_API), undefined);
  });

  it("never reads a key inherited from Object.prototype (R-SEC-2)", () => {
    Reflect.set(Object.prototype, "etherscan-v2", ETHERSCAN_KEY);
    try {
      const ctx = keyed(routeOf("etherscan-v2", ETHERSCAN_API), {});
      assert.equal(keyFor(ctx, "etherscan-v2", ETHERSCAN_URL), undefined);
    } finally {
      Reflect.deleteProperty(Object.prototype, "etherscan-v2");
    }
  });
});

describe("withKey: key placement (R-SEC-1)", () => {
  it("sends the Etherscan key in the form body, never in the URL (R-SEC-1)", async () => {
    const ctx = keyed(routeOf("etherscan-v2", ETHERSCAN_API));
    const sent: Call[] = [];
    for (const [req, fixture] of [
      [
        etherscanForm({ action: "getsourcecode", address: ADDRESS }),
        "getsourcecode-form-post-key-in-body",
      ],
      [
        etherscanForm({ action: "checkverifystatus", guid: GUID }),
        "checkverifystatus-form-post-key-in-body",
      ],
    ] as const) {
      const { body, call } = await sendTo(
        "etherscan-v2",
        withKey(ctx, "etherscan-v2", req),
        etherscan(fixture),
      );
      assert.equal(keyErrorOf("etherscan-v2", body, [ETHERSCAN_KEY]), undefined);
      sent.push(call);
    }
    for (const call of sent) {
      assert.equal(call.method, "POST");
      assert.equal(call.url, ETHERSCAN_URL);
      assert.ok(!call.url.includes(ETHERSCAN_KEY));
      assert.equal(call.headers.get("apikey"), null);
      assert.equal(call.headers.get("x-api-key"), null);
      assert.equal(new URLSearchParams(call.body).get("apikey"), ETHERSCAN_KEY);
      assert.equal(new URLSearchParams(call.body).get("chainid"), null);
    }
  });

  it("leaves the caller's form body unchanged and keeps its fields (R-SEC-1)", () => {
    const ctx = keyed(routeOf("etherscan-v2", ETHERSCAN_API));
    const req = etherscanForm({ action: "getsourcecode", address: ADDRESS });
    const out = withKey(ctx, "etherscan-v2", req);
    assert.notEqual(out, req);
    assert.ok(req.body instanceof URLSearchParams);
    assert.equal(req.body.get("apikey"), null);
    assert.ok(out.body instanceof URLSearchParams);
    assert.equal(out.body.get("address"), ADDRESS);
    assert.equal(out.url, req.url);
  });

  it("puts a standalone explorer's route.apiKey in the form body (R-SEC-1)", () => {
    const ctx = keyed(routeOf("etherscan-compatible", STANDALONE_API, STANDALONE_KEY));
    const req = {
      ...etherscanForm({ action: "getsourcecode" }),
      url: `${STANDALONE_API}?chainid=1`,
    };
    const out = withKey(ctx, "etherscan-compatible", req);
    assert.ok(out.body instanceof URLSearchParams);
    assert.equal(out.body.get("apikey"), STANDALONE_KEY);
    assert.ok(!out.url.includes(STANDALONE_KEY));
  });

  it("refuses to place an Etherscan key in a GET or a body that is not a form, as a library bug (R-SEC-1)", () => {
    const ctx = keyed(routeOf("etherscan-v2", ETHERSCAN_API));
    for (const req of [
      { url: ETHERSCAN_URL, method: "GET", retry: "safe" },
      { url: ETHERSCAN_URL, method: "POST", body: "module=contract", retry: "safe" },
      // A GET with a form body: the method alone must refuse it.
      {
        url: ETHERSCAN_URL,
        method: "GET",
        body: new URLSearchParams({ module: "contract" }),
        retry: "safe",
      },
    ] as const) {
      let caught: unknown;
      try {
        withKey(ctx, "etherscan-v2", req);
      } catch (error: unknown) {
        caught = error;
      }
      // Not an ExplorerVerifyError: the caller cannot fix it, and the CLI reports internal-error.
      assert.ok(caught instanceof Error);
      assert.ok(!(caught instanceof ExplorerVerifyError));
      assert.match(caught.message, /^explorer-verify bug: .*Report it at https:\/\/github\.com/);
      assert.ok(!caught.message.includes(ETHERSCAN_KEY));
    }
  });

  it("replaces an apikey field already in the body, so exactly one key is sent (R-SEC-1)", () => {
    const ctx = keyed(routeOf("etherscan-v2", ETHERSCAN_API));
    const req = etherscanForm({ action: "getsourcecode", apikey: "placeholder" });
    const out = withKey(ctx, "etherscan-v2", req);
    assert.ok(out.body instanceof URLSearchParams);
    assert.deepEqual(out.body.getAll("apikey"), [ETHERSCAN_KEY]);
  });

  it("sends the Routescan key in the apikey header (R-SEC-1)", async () => {
    const ctx = keyed(routeOf("routescan", ROUTESCAN_API));
    const url = `${ROUTESCAN_API}?module=contract&action=getsourcecode&address=0x636522C3785337399Aa9105498d2Bd95Dc01D749`;
    const req: HttpRequest = {
      url,
      method: "GET",
      headers: { accept: "application/json" },
      retry: "safe",
    };
    const out = withKey(ctx, "routescan", req);
    assert.deepEqual(req.headers, { accept: "application/json" });
    const { body, call } = await sendTo(
      "routescan",
      out,
      loadFixture("routescan", "2026-11-03-getsourcecode-invalid-key-header"),
    );
    assert.equal(call.headers.get("apikey"), ROUTESCAN_KEY);
    assert.equal(call.headers.get("accept"), "application/json");
    assert.equal(call.url, url);
    assert.ok(!call.url.includes(ROUTESCAN_KEY));
    assert.equal(call.body, undefined);
    // Routescan answered a made-up key on its keyless tier without refusing it (live, 2026-11-03).
    assert.equal(keyErrorOf("routescan", body, [ROUTESCAN_KEY]), undefined);
  });

  it("adds no key for a backend without a known placement (R-SEC-2)", () => {
    const ctx = keyed(routeOf("blockscout", "https://eth.blockscout.com/api", STANDALONE_KEY));
    const req: HttpRequest = {
      url: "https://eth.blockscout.com/api",
      method: "GET",
      retry: "safe",
    };
    assert.equal(withKey(ctx, "blockscout", req), req);
  });
});

describe("requireKey: a missing key before any request (R-AX-7, R-SRV-5)", () => {
  const sourcifyLike: Backend = {
    name: "etherscan-v2",
    lookup: () => Promise.reject(new Error("no request expected")),
    submit: () => Promise.reject(new Error("no request expected")),
    poll: () => Promise.reject(new Error("no request expected")),
    explorerUrl: () => undefined,
  };
  const target = { chainId: 421614, address: ADDRESS } as const;

  it("throws missing-api-key before any request when no key and no fetch are set (R-AX-7)", (t) => {
    const spy = t.mock.method(globalThis, "fetch", () => Promise.reject(new Error("no request")));
    const error = thrown(() =>
      openCall(settingsOf({}), routeOf("etherscan-v2", ETHERSCAN_API), target, {
        backends: { "etherscan-v2": sourcifyLike },
      }),
    );
    assertKeyError(error, "missing-api-key");
    assert.equal(
      error.message,
      "etherscan-v2 needs an API key and none is set for api.etherscan.io: set apiKeys.etherscan-v2.",
    );
    assert.equal(spy.mock.callCount(), 0);
  });

  it("says that apiKeys does not follow an apiUrl on another host (R-SEC-2)", () => {
    const route = routeOf("etherscan-v2", "https://proxy.example.org/etherscan");
    const error = thrown(() => {
      requireKey(keyed(route), false, [ETHERSCAN_KEY]);
    });
    assertKeyError(error, "missing-api-key");
    assert.match(error.message, /apiKeys\.etherscan-v2 is sent only to api\.etherscan\.io/);
    assert.match(error.message, /set route\.apiKey for proxy\.example\.org/);
  });

  it("opens the call when the key is bound to the route's host (R-SEC-2)", () => {
    const call = openCall(
      settingsOf({ apiKeys: { "etherscan-v2": ETHERSCAN_KEY } }),
      routeOf("etherscan-v2", ETHERSCAN_API),
      target,
      { backends: { "etherscan-v2": sourcifyLike } },
    );
    assert.deepEqual(call.ctx.apiKeys?.(), { "etherscan-v2": ETHERSCAN_KEY });
    assert.ok(call.ctx.http.secrets.includes(ETHERSCAN_KEY));
    // The context holds the keys behind a function, so printing it shows none (R-SEC-1).
    assert.ok(
      !JSON.stringify({ apiKeys: call.ctx.apiKeys, route: call.ctx.route }).includes(ETHERSCAN_KEY),
    );
    requireKey(keyed(routeOf("etherscan-v2", ETHERSCAN_API, ETHERSCAN_KEY), {}), false, []);
  });

  it("opens a keyed call without a key when fetch is injected (R-SRV-5)", (t) => {
    const fake = t.mock.fn(() => Promise.reject(new Error("no request expected")));
    const call = openCall(
      settingsOf({ fetch: fake }),
      routeOf("etherscan-v2", ETHERSCAN_API),
      target,
      {
        backends: { "etherscan-v2": sourcifyLike },
      },
    );
    assert.equal(call.backend.name, "etherscan-v2");
    assert.equal(fake.mock.callCount(), 0);
  });

  it("skips the check for backends that work without a key (R-SRV-5)", () => {
    requireKey({ route: routeOf("routescan", ROUTESCAN_API) }, false, []);
    requireKey({ route: routeOf("etherscan-compatible", STANDALONE_API) }, false, []);
    requireKey({ route: resolveRoute(1) }, false, []);
  });

  it("maps Missing/Invalid API Key to missing-api-key with an injected fetch (R-SRV-5)", async () => {
    const ctx = { route: routeOf("etherscan-v2", ETHERSCAN_API) };
    requireKey(ctx, true, []);
    const req = withKey(
      ctx,
      "etherscan-v2",
      etherscanForm({ action: "getsourcecode", address: ADDRESS }),
    );
    const { body, call } = await sendTo("etherscan-v2", req, etherscan("getsourcecode-no-key"));
    assert.equal(new URLSearchParams(call.body).get("apikey"), null);
    assertKeyError(keyErrorOf("etherscan-v2", body, []), "missing-api-key");
  });

  it("keeps every apiKeys value and route.apiKey in the call's secrets (R-SEC-1)", () => {
    const settings = settingsOf({ apiKeys: { ...KEYS } });
    assert.deepEqual(settings.keySecrets(), [ETHERSCAN_KEY, ROUTESCAN_KEY]);
    assert.ok(!JSON.stringify(settings).includes(ETHERSCAN_KEY));
    const call = openCall(
      settings,
      routeOf("etherscan-v2", ETHERSCAN_API, STANDALONE_KEY),
      target,
      { backends: { "etherscan-v2": sourcifyLike } },
    );
    for (const key of [ETHERSCAN_KEY, ROUTESCAN_KEY, STANDALONE_KEY]) {
      assert.ok(call.ctx.http.secrets.includes(key), key);
    }
  });

  it("keeps an invalid apiKeys value out of the error it causes (R-SEC-1)", () => {
    // The bad value is a known key plus a forbidden character; only the call's secrets can
    // redact it, because no redaction rule matches its shape.
    const bad = `${ETHERSCAN_KEY}!x`;
    const error = optionsError({ apiKeys: { "etherscan-v2": bad, mystery: STANDALONE_KEY } });
    const read = readApiKeys({ "etherscan-v2": bad, mystery: STANDALONE_KEY });
    assert.deepEqual(read.secrets, [bad, STANDALONE_KEY]);
    assert.deepEqual(read.keys, {});
    const text = JSON.stringify([error.message, error.hint, error.details, error.toJSON()]);
    assert.ok(!text.includes(bad), text);
    assert.ok(!text.includes(STANDALONE_KEY), text);
  });

  it("refuses a key found in the address or the handle's fixed part, before any request (R-SEC-1)", (t) => {
    const spy = t.mock.method(globalThis, "fetch", () => Promise.reject(new Error("no request")));
    for (const [apiKeys, field] of [
      [{ "etherscan-v2": "F20CFAE8007a" }, "apiKeys.etherscan-v2"],
      [{ routescan: "ETHERSCAN-V2" }, "apiKeys.routescan"],
      [{ routescan: "ev1.ok.key", "etherscan-v2": "A375E1771C4" }, "apiKeys.etherscan-v2"],
    ] as const) {
      const error = thrown(() =>
        openCall(settingsOf({ apiKeys }), routeOf("etherscan-v2", ETHERSCAN_API), target, {
          backends: { "etherscan-v2": sourcifyLike },
        }),
      );
      assert.deepEqual(error.details, {
        code: "invalid-input",
        issues: [{ field, message: "must not appear in the contract address or the handle" }],
      });
    }
    const routeError = thrown(() =>
      openCall(settingsOf({}), routeOf("etherscan-v2", ETHERSCAN_API, "0xf20cfae8"), target, {
        backends: { "etherscan-v2": sourcifyLike },
      }),
    );
    assert.deepEqual(routeError.details, {
      code: "invalid-input",
      issues: [
        { field: "route.apiKey", message: "must not appear in the contract address or the handle" },
      ],
    });
    assert.equal(spy.mock.callCount(), 0);
  });

  it("keeps apiKeys in the context of the lookup after a forgotten job (R-SEC-2)", async () => {
    const seen: unknown[] = [];
    const backend: Backend = {
      ...sourcifyLike,
      name: "sourcify",
      poll: async (handle) => {
        throw new ExplorerVerifyError({ code: "job-not-found", handle }, "gone", {
          secrets: [],
        });
      },
      lookup: async (_target, ctx) => {
        seen.push(ctx.apiKeys?.());
        return undefined;
      },
    };
    const handle = {
      version: 1,
      backend: "sourcify",
      chainId: 11155111,
      address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
      jobId: "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718",
    };
    await assert.rejects(
      runCheckStatus(handle, { apiKeys: KEYS }, { backends: { sourcify: backend } }),
      { code: "job-not-found" },
    );
    assert.deepEqual(seen, [KEYS]);
  });
});

describe("keyErrorOf: explorer answers about a key (R-AX-7)", () => {
  it("maps Invalid API Key (#err2) to api-key-rejected (R-AX-7)", async () => {
    assertKeyError(
      keyErrorOf("etherscan-v2", await answerOf("getsourcecode-invalid-key"), [ETHERSCAN_KEY]),
      "api-key-rejected",
    );
  });

  it("maps a key sent in a header, which Etherscan ignores, to missing-api-key (R-AX-7)", async () => {
    for (const name of [
      "getsourcecode-key-in-apikey-header",
      "getsourcecode-key-in-x-api-key-header",
    ]) {
      assertKeyError(keyErrorOf("etherscan-v2", await answerOf(name), []), "missing-api-key");
    }
  });

  it("maps a spent daily limit to quota-exceeded, not retryable (R-AX-7)", () => {
    for (const result of [
      "Max daily rate limit reached. 100000 (100%) of 100000 day/limit",
      "Daily limit of 500 source code submissions reached",
    ]) {
      assertKeyError(
        keyErrorOf("etherscan-v2", { status: "0", message: "NOTOK", result }, []),
        "quota-exceeded",
      );
    }
  });

  it("maps any other answer to no key error", () => {
    for (const body of [
      { status: "0", message: "NOTOK", result: "Max calls per sec rate limit reached (5/sec)" },
      { status: "0", message: "NOTOK", result: "Pending in queue" },
      // No recorded answer says this: only the recorded `Missing/Invalid API Key` maps.
      { status: "0", message: "NOTOK", result: "Missing API Key" },
      { status: "0", result: "daily" },
      { status: "0", result: `Daily ${"x".repeat(80)} limit` },
      { status: "1", message: "OK", result: "Invalid API Key (#err2)" },
      { status: "0", message: "NOTOK", result: ["Missing/Invalid API Key"] },
      { status: 0, result: "Missing/Invalid API Key" },
      ["Missing/Invalid API Key"],
      "Missing/Invalid API Key",
      null,
    ]) {
      assert.equal(keyErrorOf("etherscan-v2", body, []), undefined, JSON.stringify(body));
    }
  });

  it("names the backend only, never the explorer's text or the key (R-SEC-1)", () => {
    const error = keyErrorOf(
      "routescan",
      { status: "0", message: "NOTOK", result: `Invalid API Key ${ROUTESCAN_KEY}` },
      [ROUTESCAN_KEY],
    );
    assert.ok(error !== undefined);
    assert.deepEqual(error.details, { code: "api-key-rejected", backend: "routescan" });
    assert.equal(error.message, "routescan answered that the API key is not valid.");
  });
});

describe("apiKeys and route.apiKey: options validation (R-SEC-1, R-IN-6)", () => {
  const CHARSET = "must hold only letters, digits, '.', '_', '~' and '-'";

  it("rejects a key with whitespace and never echoes it (R-SEC-1)", () => {
    for (const bad of [`${ETHERSCAN_KEY} x`, `${ETHERSCAN_KEY}\n`, `\t${ETHERSCAN_KEY}`]) {
      const error = optionsError({ apiKeys: { "etherscan-v2": bad } });
      assert.deepEqual(error.details, {
        code: "invalid-input",
        issues: [{ field: "apiKeys.etherscan-v2", message: CHARSET }],
      });
      const text = JSON.stringify([error.message, error.hint, error.toJSON(), String(error.stack)]);
      assert.ok(!text.includes(ETHERSCAN_KEY), text);
    }
  });

  it("accepts only the RFC 3986 unreserved characters, 8 to 1024 of them, not all digits (R-SEC-1)", () => {
    assert.deepEqual(checkKey(ETHERSCAN_KEY), { key: ETHERSCAN_KEY });
    assert.deepEqual(checkKey("ABCDEFGH"), { key: "ABCDEFGH" });
    assert.deepEqual(checkKey("a.b_c~d-e"), { key: "a.b_c~d-e" });
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    assert.deepEqual(checkKey(uuid), { key: uuid });
    assert.deepEqual(checkKey("x".repeat(MAX_KEY_LENGTH)), { key: "x".repeat(MAX_KEY_LENGTH) });
    assert.equal(checkKey("short12"), "must be at least 8 characters");
    assert.equal(checkKey(""), "must be at least 8 characters");
    assert.equal(checkKey("x".repeat(MAX_KEY_LENGTH + 1)), "must be at most 1024 characters");
    assert.equal(checkKey("12345678"), "must not be all digits");
    // Each of these could reach an answer escaped in a form redaction does not match.
    for (const char of [
      "&",
      "<",
      '"',
      "/",
      "\\",
      "+",
      "=",
      "%",
      "?",
      "#",
      "é",
      "\u0000",
      " ",
      " ",
    ]) {
      assert.equal(checkKey(`${ETHERSCAN_KEY}${char}`), CHARSET, JSON.stringify(char));
    }
    for (const value of [42, null, ["key"], { key: ETHERSCAN_KEY }, Object(ETHERSCAN_KEY)]) {
      assert.equal(checkKey(value), "must be a string");
    }
  });

  it("accepts etherscan-v2 and routescan keys, and treats undefined as absent with no issue", () => {
    assert.deepEqual(settingsOf({ apiKeys: KEYS }).apiKeys(), KEYS);
    assert.deepEqual(settingsOf({ apiKeys: { routescan: undefined } }).apiKeys(), {});
    assert.deepEqual(readApiKeys({ "etherscan-v2": undefined }), {
      keys: {},
      issues: [],
      secrets: [],
    });
    assert.deepEqual(readApiKeys(undefined), { keys: {}, issues: [], secrets: [] });
    const bare: Record<string, string> = Object.create(null);
    bare.routescan = ROUTESCAN_KEY;
    assert.deepEqual(readApiKeys(bare).keys, { routescan: ROUTESCAN_KEY });
    assert.deepEqual(settingsOf(undefined).apiKeys(), {});
    assert.deepEqual(settingsOf(undefined).keySecrets(), []);
  });

  it("refuses etherscan-compatible, sourcify and blockscout keys (decision 0016)", () => {
    const error = optionsError({
      apiKeys: {
        "etherscan-compatible": STANDALONE_KEY,
        sourcify: STANDALONE_KEY,
        blockscout: STANDALONE_KEY,
      },
    });
    assert.deepEqual(error.details, {
      code: "invalid-input",
      issues: [
        {
          field: "apiKeys.etherscan-compatible",
          message:
            "is not accepted: pass a standalone explorer's key as route.apiKey with its apiUrl",
        },
        {
          field: "apiKeys.sourcify",
          message: "is not accepted: sourcify takes no API key in this version",
        },
        {
          field: "apiKeys.blockscout",
          message: "is not accepted: blockscout takes no API key in this version",
        },
      ],
    });
    assert.ok(!JSON.stringify(error.toJSON()).includes(STANDALONE_KEY));
  });

  it("counts names that are not backends and never repeats them (R-SEC-1)", () => {
    for (const [apiKeys, message] of [
      [{ [ETHERSCAN_KEY]: "x" }, "has 1 field that is not a backend name"],
      [
        { ETHERSCAN: ETHERSCAN_KEY, etherscan: ETHERSCAN_KEY },
        "has 2 fields that are not backend names",
      ],
    ] as const) {
      const error = optionsError({ apiKeys });
      assert.deepEqual(error.details, {
        code: "invalid-input",
        issues: [{ field: "apiKeys", message }],
      });
      const text = JSON.stringify([error.message, error.toJSON(), error.details]);
      assert.ok(!text.includes(ETHERSCAN_KEY), text);
    }
  });

  it("lists every problem, apiKeys after the other options", () => {
    const error = optionsError({ timeoutMs: -1, apiKeys: { routescan: "short", foo: "x" } });
    assert.deepEqual(
      error.details.code === "invalid-input"
        ? error.details.issues.map((issue) => issue.field)
        : [],
      ["timeoutMs", "apiKeys", "apiKeys.routescan"],
    );
  });

  it("refuses apiKeys that is not a plain object, or cannot be read", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error(ETHERSCAN_KEY);
        },
      },
    );
    class Keys {
      readonly "etherscan-v2" = ETHERSCAN_KEY;
    }
    for (const apiKeys of [ETHERSCAN_KEY, null, [ETHERSCAN_KEY], new Keys(), new Map(), hostile]) {
      const error = optionsError({ apiKeys });
      assert.deepEqual(error.details, {
        code: "invalid-input",
        issues: [{ field: "apiKeys", message: "must be a plain object" }],
      });
      assert.ok(!JSON.stringify([error.message, error.toJSON()]).includes(ETHERSCAN_KEY));
    }
  });

  it("ignores keys and apiKeys added to a polluted Object.prototype (R-SEC-2)", () => {
    Reflect.set(Object.prototype, "etherscan-v2", ETHERSCAN_KEY);
    try {
      assert.deepEqual(readApiKeys({}), { keys: {}, issues: [], secrets: [] });
      assert.deepEqual(settingsOf({ apiKeys: {} }).apiKeys(), {});
    } finally {
      Reflect.deleteProperty(Object.prototype, "etherscan-v2");
    }
    Reflect.set(Object.prototype, "apiKeys", KEYS);
    try {
      const settings = settingsOf({});
      assert.deepEqual(settings.apiKeys(), {});
      assert.deepEqual(settings.keySecrets(), []);
    } finally {
      Reflect.deleteProperty(Object.prototype, "apiKeys");
    }
    Reflect.set(Object.prototype, "apiKey", ETHERSCAN_KEY);
    try {
      assert.equal(resolveRoute(1, {}).apiKey(), undefined);
    } finally {
      Reflect.deleteProperty(Object.prototype, "apiKey");
    }
  });

  it("ignores a non-enumerable property and a Symbol key, as documented", () => {
    const hidden = {};
    Object.defineProperty(hidden, "routescan", { value: ROUTESCAN_KEY, enumerable: false });
    Reflect.set(hidden, Symbol("etherscan-v2"), ETHERSCAN_KEY);
    assert.deepEqual(readApiKeys(hidden), { keys: {}, issues: [], secrets: [] });
  });

  it("refuses route.apiKey for sourcify, without apiUrl, and when the value is bad, never echoing it (R-SEC-1)", () => {
    const apiUrl = "https://sourcify.example.org/server";
    const noKey = "is not accepted: sourcify takes no API key";
    for (const [override, message] of [
      [{ apiUrl, apiKey: STANDALONE_KEY }, noKey],
      [{ backend: "sourcify", apiUrl, apiKey: STANDALONE_KEY }, noKey],
      [{ apiUrl, apiKey: `${STANDALONE_KEY} ` }, CHARSET],
      [{ apiUrl, apiKey: 12345678 }, "must be a string"],
    ] as const) {
      const route: RouteOverride = Object(override);
      const error = thrown(() => resolveRoute(1, route));
      assert.deepEqual(error.details, {
        code: "invalid-input",
        issues: [{ field: "route.apiKey", message }],
      });
      assert.match(error.hint, /route\.apiKey/);
      const text = JSON.stringify([error.message, error.hint, error.toJSON()]);
      assert.ok(!text.includes(STANDALONE_KEY), text);
    }
  });

  it("keeps the apiUrl hint when both route.apiUrl and route.apiKey are bad", () => {
    const error = thrown(() => resolveRoute(1, { apiUrl: "ftp://x.example", apiKey: "short" }));
    assert.deepEqual(
      error.details.code === "invalid-input" ? error.details.issues.map((i) => i.field) : [],
      ["route.apiUrl", "route.apiKey"],
    );
    assert.doesNotMatch(error.hint, /^Pass route\.apiKey/);
  });

  it("takes route.apiKey only for Etherscan-family, Routescan and hosted Blockscout routes, next to apiUrl (decisions 0016, 0041)", () => {
    assert.deepEqual(
      BACKEND_NAMES.filter(
        (name) => checkRouteKey(name, STANDALONE_KEY, true).key === STANDALONE_KEY,
      ),
      ["etherscan-v2", "etherscan-compatible", "blockscout-hosted", "routescan"],
    );
    // Without apiUrl, a standalone key could reach the routing table's host for the chain.
    for (const name of [
      "etherscan-v2",
      "etherscan-compatible",
      "blockscout-hosted",
      "routescan",
    ] as const) {
      assert.deepEqual(checkRouteKey(name, STANDALONE_KEY, false), {
        issue: "needs route.apiUrl: the key is sent only to that host",
      });
    }
    assert.deepEqual(checkRouteKey("routescan", undefined, false), {});
    assert.deepEqual(checkRouteKey("routescan", "short", true), {
      issue: "must be at least 8 characters",
    });
    assert.deepEqual(checkRouteKey("sourcify", "short", true), {
      issue: "must be at least 8 characters",
    });
  });
});
