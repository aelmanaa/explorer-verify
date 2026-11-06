// linkProxy() and the proxy-link code of each backend (R-FLOW-8, R-FLOW-4, R-SEC-1, R-RUN-5).
// The explorer answers are recorded live on Ethereum Sepolia on 2026-11-04, from a minimal
// ERC-1967 proxy (BoxProxy) and its implementation (Box), in test/fixtures/<backend>/; two
// Etherscan answers come from its documentation and from a run on 2026-11-03, and Blockscout's
// "not detected" and multi-implementation texts come from its source. Every request goes to a fake
// fetch. Polling and waits run on mock timers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import type {
  Context,
  LinkStep,
  LinkTarget,
  LinkVerdict,
  ProxyLinker,
} from "../../src/backends/backend.ts";
import { blockscoutProxyLinker } from "../../src/backends/proxy-blockscout.ts";
import { compatibleProxyLinker, etherscanProxyLinker } from "../../src/backends/proxy-etherscan.ts";
import { sourcifyProxyLinker } from "../../src/backends/proxy-sourcify.ts";
import { ERROR_EXIT_CODES, ExplorerVerifyError } from "../../src/errors.ts";
import { DEFAULT_LINK_DEPENDENCIES } from "../../src/flow/defaults.ts";
import type { LinkDependencies } from "../../src/flow/link-proxy.ts";
import { linkProxy } from "../../src/index.ts";
import type {
  LinkProxyResult,
  LinkProxyTarget,
  VerifyEvent,
  VerifyOptions,
} from "../../src/types.ts";
import { runLinkProxy } from "../helpers/defaults.ts";
import { loadFixture, replay, responseOf } from "../helpers/fake-fetch.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { resolveRoute } from "../helpers/route.ts";

const SEPOLIA = 11155111;
const PROXY = "0xed5b8413e605598ef86cd7617f12701f74ca255c";
const PROXY_MIXED = "0xED5B8413e605598EF86CD7617f12701F74ca255C";
const BOX = "0x75038a8c55f5ec7196b54384fdbcffb1f2ce9920";
const OTHER_PROXY = "0xfa0e910758d502780263871f92a85736597b87f4";
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const ZERO = `0x${"0".repeat(40)}`;
// 80 hex digits: two addresses run together, which must never read as one.
const LONG = `0x${"75038a8c55f5ec7196b54384fdbcffb1f2ce9920".repeat(2)}`;
const BLOCKSCOUT_API = "https://eth-sepolia.blockscout.com/api";
// Fake keys. Never real ones (R-SEC-1).
const KEY = "deadbeef0123456789abcdef94a10001";
const ROUTE_KEY = "cafebabe0123456789abcdef94b20002";

const etherscan = (name: string): Step => loadFixture("etherscan", name);
const blockscout = (name: string): Step => loadFixture("blockscout", name);
const sourcify = (name: string): Step => loadFixture("sourcify", name);

const REQUESTED = (): Step => etherscan("2026-11-04-verifyproxycontract-linked");
const LINKED = (): Step => etherscan("2026-11-04-checkproxyverification-linked");
const PENDING_0 = (): Step =>
  etherscan("2026-11-03-documented-checkproxyverification-pending-status-0");
const ACCEPTED = (): Step => blockscout("2026-11-04-verifyproxycontract-accepted");
const BS_LINKED = (): Step => blockscout("2026-11-04-checkproxyverification-linked");
const ONE_ATTEMPT = (): Step => blockscout("2026-11-04-verifyproxycontract-one-attempt");
const MISMATCH_TEXT =
  "The provided expected results are different than the retrieved implementation address!";

/** A JSON answer with HTTP 200. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** An Etherscan-style answer with this `result`. */
function etherscanText(result: unknown, status: "0" | "1" = "0"): Response {
  return json({ status, message: status === "1" ? "OK" : "NOTOK", result });
}

/** The "found at" text of Etherscan and Blockscout, for `proxy` and `found`. */
function foundText(found: string, proxy = PROXY, rest = "is successfully updated."): string {
  return `The proxy's (${proxy}) implementation contract is found at ${found} and ${rest}`;
}

/** A 200 answer that is not JSON: a failed check. */
function broken(): Response {
  return new Response("<html>busy</html>", { status: 200 });
}

/** Etherscan's `getsourcecode` of a proxy whose record holds `implementation`. */
function record(implementation: unknown): Response {
  return etherscanText([{ SourceCode: "", Proxy: "1", Implementation: implementation }], "1");
}

/** Blockscout's REST lookup of a fully verified contract. */
function LOOKUP_VERIFIED(): Response {
  return json({ is_verified: true, is_fully_verified: true, is_partially_verified: false });
}

/** Blockscout's REST lookup of an unverified contract, recorded. */
function LOOKUP_UNVERIFIED(): Step {
  return loadFixture("blockscout", "2026-11-04-lookup-unverified");
}

/** Blockscout's REST lookup of the proxy with these `implementations`. */
function proxyLookup(implementations: unknown): Response {
  return json({ proxy_type: "eip1967", implementations, deployed_bytecode: "0x60" });
}

/** Sourcify's lookup of the verified Box implementation. */
function BOX_VERIFIED(): Response {
  return json({ match: "exact_match", chainId: String(SEPOLIA), address: BOX });
}

/** A Sourcify proxy lookup of the proxy with this `proxyResolution`. */
function resolution(value: unknown): Response {
  return json({
    match: "exact_match",
    proxyResolution: value,
    chainId: String(SEPOLIA),
    address: PROXY,
  });
}

/** A linker that answers `verdict` to every request and check, and has no `verified`. */
function linker(verdict: LinkVerdict): ProxyLinker {
  return {
    request: async (_target: LinkTarget, _ctx: Context): Promise<LinkVerdict> =>
      await Promise.resolve(verdict),
    check: async (): Promise<LinkVerdict> => await Promise.resolve(verdict),
  };
}

/** A link request that a fake linker accepted. */
async function submitted(): Promise<LinkStep> {
  return await Promise.resolve({ state: "submitted", jobId: "job1" });
}

const ETHERSCAN_OPTIONS: VerifyOptions = {
  route: { backend: "etherscan-v2" },
  apiKeys: { "etherscan-v2": KEY },
};
const BLOCKSCOUT_OPTIONS: VerifyOptions = {
  route: { backend: "blockscout", apiUrl: BLOCKSCOUT_API },
};
const SOURCIFY_OPTIONS: VerifyOptions = { route: { backend: "sourcify" } };

interface Run {
  readonly outcome: { readonly result?: LinkProxyResult; readonly error?: unknown };
  readonly calls: Call[];
  readonly events: VerifyEvent[];
  /** The mock clock's time when each request was sent. */
  readonly times: number[];
}

/** Runs linkProxy() against `steps` on mock timers, until it settles. */
async function run(
  t: TestContext,
  steps: Step[],
  options: VerifyOptions,
  target: unknown = { chainId: SEPOLIA, address: PROXY },
  dependencies: LinkDependencies = DEFAULT_LINK_DEPENDENCIES,
): Promise<Run> {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = replay(...steps);
  const times: number[] = [];
  const timed: typeof fetch = async (input, init) => {
    times.push(Date.now());
    return await fake.fetch(input, init);
  };
  const events: VerifyEvent[] = [];
  const call = runLinkProxy(
    target,
    {
      timeoutMs: 20_000,
      pollIntervalMs: 3_000,
      ...options,
      fetch: timed,
      onEvent: (event) => {
        events.push(event);
      },
    },
    dependencies,
  );
  await driveMockClock(call, () => {
    t.mock.timers.runAll();
  });
  try {
    return { outcome: { result: await call }, calls: fake.calls, events, times };
  } catch (error: unknown) {
    return { outcome: { error }, calls: fake.calls, events, times };
  }
}

function resultOf(r: Run): LinkProxyResult {
  assert.ok(r.outcome.result !== undefined, `expected a result, got ${String(r.outcome.error)}`);
  return r.outcome.result;
}

function errorOf(r: Run, code: ExplorerVerifyError["code"]): ExplorerVerifyError {
  const { error } = r.outcome;
  assert.ok(
    error instanceof ExplorerVerifyError,
    `expected an error, got ${JSON.stringify(r.outcome.result)}`,
  );
  assert.equal(error.code, code, error.message);
  return error;
}

/** The `action` of each form request, or the URL of each GET. */
function actions(r: Run): string[] {
  return r.calls.map((call) =>
    call.method === "GET" ? call.url : String(new URLSearchParams(call.body).get("action")),
  );
}

/** Everything a caller can see of a run, as text, to check that no key appears (R-SEC-1). */
function visible(r: Run): string {
  const { error, result } = r.outcome;
  const parts = [JSON.stringify(result ?? null), JSON.stringify(r.events)];
  if (error instanceof ExplorerVerifyError) {
    parts.push(error.message, error.hint, JSON.stringify(error), JSON.stringify(error.details));
    parts.push(String(error.stack), error.cause instanceof Error ? error.cause.message : "");
  }
  return parts.join("\n");
}

/** Asserts a `proxy-link-unknown-state` error with no handle, exit code 6, not retryable. */
function unknownLinkState(r: Run, backend: string): ExplorerVerifyError {
  const error = errorOf(r, "proxy-link-unknown-state");
  assert.equal(error.details.code === "proxy-link-unknown-state" && error.details.backend, backend);
  assert.equal(error.toJSON().handle, undefined);
  assert.equal(error.retryable, false);
  assert.equal(ERROR_EXIT_CODES[error.code], 6);
  return error;
}

describe("linkProxy() on Etherscan v2 (R-FLOW-8)", () => {
  it("links the proxy with recorded answers: request, then one check", async (t) => {
    const r = await run(t, [REQUESTED(), LINKED()], ETHERSCAN_OPTIONS, {
      chainId: SEPOLIA,
      address: PROXY_MIXED,
      expectedImplementation: `0x${BOX.slice(2).toUpperCase()}`,
    });
    assert.deepEqual(resultOf(r), {
      status: "linked",
      backend: "etherscan-v2",
      implementation: BOX,
      implementationVerified: true,
      explorerUrl: `https://sepolia.etherscan.io/address/${PROXY}#code`,
    });
    const [request, check] = r.calls;
    assert.equal(request?.url, `https://api.etherscan.io/v2/api?chainid=${String(SEPOLIA)}`);
    assert.equal(request?.method, "POST");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(request?.body)), {
      module: "contract",
      action: "verifyproxycontract",
      address: PROXY,
      expectedimplementation: BOX,
      apikey: KEY,
    });
    assert.deepEqual(Object.fromEntries(new URLSearchParams(check?.body)), {
      module: "contract",
      action: "checkproxyverification",
      guid: "wccgmdtjug6bss2mf166jzjtqcs4uchztznlevycg6mbwlxttz",
      apikey: KEY,
    });
    // The key goes in the body only (decision 0016, R-SEC-1).
    assert.ok(r.calls.every((call) => !call.url.includes(KEY)));
    assert.ok(!visible(r).includes(KEY));
    // linkProxy emits verify.routed, and no verify.validated or verify.result.
    assert.deepEqual(
      r.events.map((event) => event.type),
      ["verify.routed"],
    );
  });

  it("sends no expectedimplementation when the target has none", async (t) => {
    const r = await run(t, [REQUESTED(), LINKED()], ETHERSCAN_OPTIONS);
    assert.equal(resultOf(r).status, "linked");
    assert.equal(new URLSearchParams(r.calls[0]?.body).has("expectedimplementation"), false);
  });

  it("reports an implementation without ABI as linked but not verified", async (t) => {
    const r = await run(
      t,
      [
        etherscan("2026-11-04-verifyproxycontract-unverified-implementation"),
        etherscan("2026-11-04-checkproxyverification-unverified-implementation"),
      ],
      ETHERSCAN_OPTIONS,
    );
    const result = resultOf(r);
    assert.equal(result.status === "linked" && result.implementationVerified, false);
    assert.equal(result.status === "linked" && result.implementation, BOX);
  });

  it("links a proxy Etherscan has not verified, as it did live", async (t) => {
    const r = await run(
      t,
      [
        etherscan("2026-11-04-verifyproxycontract-unverified-proxy"),
        etherscan("2026-11-04-checkproxyverification-unverified-proxy"),
      ],
      ETHERSCAN_OPTIONS,
      { chainId: SEPOLIA, address: OTHER_PROXY },
    );
    assert.equal(resultOf(r).status, "linked");
  });

  it("keeps Pending in queue with status 0 pending, one verify.poll per check (R-FLOW-4)", async (t) => {
    const r = await run(t, [REQUESTED(), PENDING_0(), PENDING_0(), LINKED()], ETHERSCAN_OPTIONS);
    assert.equal(resultOf(r).status, "linked");
    assert.deepEqual(
      r.events.filter((event) => event.type === "verify.poll"),
      [
        { type: "verify.poll", backend: "etherscan-v2", attempt: 1, state: "pending" },
        { type: "verify.poll", backend: "etherscan-v2", attempt: 2, state: "pending" },
      ],
    );
  });

  it("gives mismatch with the implementation of Etherscan's record of the proxy", async (t) => {
    const r = await run(
      t,
      [
        etherscan("2026-11-04-verifyproxycontract-expected-mismatch"),
        etherscan("2026-11-04-checkproxyverification-expected-mismatch"),
        etherscan("2026-11-04-getsourcecode-other-box-proxy"),
      ],
      ETHERSCAN_OPTIONS,
      { chainId: SEPOLIA, address: OTHER_PROXY, expectedImplementation: GREETER },
    );
    assert.deepEqual(resultOf(r), {
      status: "mismatch",
      backend: "etherscan-v2",
      implementation: BOX,
      expectedImplementation: GREETER,
    });
    assert.deepEqual(actions(r), [
      "verifyproxycontract",
      "checkproxyverification",
      "getsourcecode",
    ]);
    assert.equal(new URLSearchParams(r.calls[2]?.body).get("address"), OTHER_PROXY);
  });

  it("gives mismatch without implementation when the record holds none, or not an address", async (t) => {
    for (const implementation of ["", ZERO, LONG, undefined]) {
      const r = await run(
        t,
        [REQUESTED(), etherscanText(MISMATCH_TEXT), record(implementation)],
        ETHERSCAN_OPTIONS,
        { chainId: SEPOLIA, address: PROXY, expectedImplementation: GREETER },
      );
      assert.deepEqual(resultOf(r), {
        status: "mismatch",
        backend: "etherscan-v2",
        expectedImplementation: GREETER,
      });
    }
  });

  it("gives mismatch when the request itself is refused for another implementation", async (t) => {
    const r = await run(t, [etherscanText(MISMATCH_TEXT), record(BOX)], ETHERSCAN_OPTIONS, {
      chainId: SEPOLIA,
      address: PROXY,
      expectedImplementation: GREETER,
    });
    assert.equal(resultOf(r).status, "mismatch");
    assert.deepEqual(actions(r), ["verifyproxycontract", "getsourcecode"]);
  });

  it("gives mismatch without implementation when the lookup after a refusal fails, at request or check time", async (t) => {
    const r = await run(
      t,
      [etherscanText(MISMATCH_TEXT), etherscanText("odd", "1")],
      ETHERSCAN_OPTIONS,
      { chainId: SEPOLIA, address: PROXY, expectedImplementation: GREETER },
    );
    assert.deepEqual(resultOf(r), {
      status: "mismatch",
      backend: "etherscan-v2",
      expectedImplementation: GREETER,
    });
    const atCheck = await run(
      t,
      [REQUESTED(), etherscanText(MISMATCH_TEXT), broken()],
      ETHERSCAN_OPTIONS,
      { chainId: SEPOLIA, address: PROXY, expectedImplementation: GREETER },
    );
    assert.deepEqual(resultOf(atCheck), {
      status: "mismatch",
      backend: "etherscan-v2",
      expectedImplementation: GREETER,
    });
    // A definitive refusal: no more checks after it.
    assert.equal(atCheck.calls.length, 3);
  });

  it("rejects with the abort reason when the signal aborts during the lookup after a refusal", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const fake = replay(etherscanText(MISMATCH_TEXT));
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (fake.calls.length === 1) {
        controller.abort(reason);
        throw reason;
      }
      return await fake.fetch(input, init);
    };
    const ctx: Context = {
      route: resolveRoute(
        SEPOLIA,
        { backend: "etherscan-v2" },
        { apiKeys: { "etherscan-v2": KEY } },
      ),
      apiKeys: () => ({ "etherscan-v2": KEY }),
      http: { backend: "etherscan-v2", secrets: [KEY], fetch, signal: controller.signal },
    };
    await assert.rejects(
      etherscanProxyLinker.check(
        "wccgmdtjug6bss2mf166jzjtqcs4uchztznlevycg6mbwlxttz",
        { chainId: SEPOLIA, address: PROXY, expectedImplementation: GREETER },
        ctx,
      ),
      (error: unknown) => error === reason,
    );
  });

  it("throws proxy-link-unknown-state for a mismatch answer to a call with no expected implementation", async (t) => {
    const r = await run(
      t,
      [REQUESTED(), etherscanText(MISMATCH_TEXT), record(BOX)],
      ETHERSCAN_OPTIONS,
    );
    unknownLinkState(r, "etherscan-v2");
  });

  for (const [name, request, check, address] of [
    [
      "an address that is not a proxy",
      "2026-11-04-verifyproxycontract-not-a-proxy",
      "2026-11-04-checkproxyverification-not-a-proxy",
      GREETER,
    ],
    [
      "an address with no code",
      "2026-11-04-verifyproxycontract-no-code",
      "2026-11-04-checkproxyverification-no-code",
      PROXY,
    ],
    [
      "a proxy that is not verified",
      "2026-11-04-verifyproxycontract-linked",
      "2026-11-03-documented-checkproxyverification-proxy-not-verified",
      PROXY,
    ],
  ] as const) {
    it(`gives not-linked for ${name}`, async (t) => {
      const r = await run(t, [etherscan(request), etherscan(check)], ETHERSCAN_OPTIONS, {
        chainId: SEPOLIA,
        address,
      });
      const result = resultOf(r);
      const body = loadFixture("etherscan", check).response.body;
      assert.deepEqual(result, {
        status: "not-linked",
        backend: "etherscan-v2",
        reason: Reflect.get(Object(body), "result"),
      });
    });
  }

  it("gives not-linked when the request itself is refused with a known text", async (t) => {
    const refusal =
      "The proxy contract at 0xed5b8413e605598ef86cd7617f12701f74ca255c does not seem to be verified. Please verify it.";
    const r = await run(t, [etherscanText(refusal)], ETHERSCAN_OPTIONS);
    assert.deepEqual(resultOf(r), {
      status: "not-linked",
      backend: "etherscan-v2",
      reason: refusal,
    });
    assert.equal(r.calls.length, 1);
  });

  it("throws proxy-link-unknown-state for Error!, unknown texts and implementations that are not one address (R-FLOW-4)", async (t) => {
    for (const answer of [
      etherscan("2026-11-04-checkproxyverification-unknown-guid"),
      etherscanText("Something new", "1"),
      etherscanText(foundText(BOX, GREETER), "1"),
      etherscanText(foundText(BOX, PROXY, "was kept."), "1"),
      etherscanText(foundText("nowhere"), "1"),
      etherscanText(foundText(LONG), "1"),
      etherscanText(foundText(`${BOX}0`), "1"),
      etherscanText(foundText(ZERO), "1"),
      etherscanText(
        `The proxy's (${PROXY}) implementation contracts are found at [${BOX}, ${GREETER}] and they've been successfully updated.`,
        "1",
      ),
    ]) {
      const r = await run(t, [REQUESTED(), answer], ETHERSCAN_OPTIONS);
      assert.equal(r.outcome.result, undefined);
      unknownLinkState(r, "etherscan-v2");
    }
  });

  it("throws unexpected-response at request time for a result that is not a documented guid, and polls nothing", async (t) => {
    for (const answer of [
      etherscanText("OK", "1"),
      etherscanText("Something new"),
      etherscanText("abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmn!", "1"),
      etherscanText("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMN", "1"),
      etherscanText(5, "1"),
    ]) {
      const r = await run(t, [answer], ETHERSCAN_OPTIONS);
      errorOf(r, "unexpected-response");
      assert.equal(r.calls.length, 1);
    }
  });

  it("throws proxy-link-pending, exit code 4 and retryable, when the budget runs out", async (t) => {
    const pending = Array.from({ length: 20 }, () => PENDING_0());
    const r = await run(t, [REQUESTED(), ...pending], { ...ETHERSCAN_OPTIONS, timeoutMs: 10_000 });
    const error = errorOf(r, "proxy-link-pending");
    assert.deepEqual(error.details, { code: "proxy-link-pending", backend: "etherscan-v2" });
    assert.equal(error.retryable, true);
    assert.equal(error.toJSON().handle, undefined);
    assert.match(error.message, /time budget ran out/);
    assert.ok(error.hint.includes("linkProxy() again"));
    // 10 s budget, a check every 3 s: three checks.
    assert.equal(r.calls.length, 4);
  });

  it("throws proxy-link-pending after three failed checks in a row, with the last as cause", async (t) => {
    const r = await run(t, [REQUESTED(), broken(), broken(), broken()], ETHERSCAN_OPTIONS);
    const error = errorOf(r, "proxy-link-pending");
    assert.match(error.message, /3 status checks in a row failed/);
    assert.ok(error.cause instanceof Error);
  });

  it("goes on after a failed check, and counts failures again from zero", async (t) => {
    const r = await run(
      t,
      [REQUESTED(), broken(), broken(), PENDING_0(), broken(), broken(), LINKED()],
      ETHERSCAN_OPTIONS,
    );
    assert.equal(resultOf(r).status, "linked");
  });

  it("throws a key answer at once, redacted (R-SEC-1)", async (t) => {
    const r = await run(
      t,
      [REQUESTED(), etherscanText(`Invalid API Key (#err2)|${KEY}`)],
      ETHERSCAN_OPTIONS,
    );
    errorOf(r, "api-key-rejected");
    assert.ok(!visible(r).includes(KEY));
  });

  it("redacts the key from a not-linked reason and from an unknown answer (R-SEC-1)", async (t) => {
    const reason = `This contract does not look like it contains any delegatecall opcode sequence. ${KEY}`;
    const refused = await run(t, [REQUESTED(), etherscanText(reason)], ETHERSCAN_OPTIONS);
    const result = resultOf(refused);
    assert.ok(result.status === "not-linked" && !result.reason.includes(KEY));
    const unknown = await run(t, [REQUESTED(), etherscanText(`odd ${KEY}`)], ETHERSCAN_OPTIONS);
    unknownLinkState(unknown, "etherscan-v2");
    assert.ok(!visible(unknown).includes(KEY));
  });

  it("throws missing-api-key before any request when no key is bound and no fetch is passed", async (t) => {
    const sent: unknown[] = [];
    t.mock.method(globalThis, "fetch", async (...args: unknown[]) => {
      sent.push(args);
      return await Promise.resolve(new Response("{}"));
    });
    await assert.rejects(
      linkProxy({ chainId: SEPOLIA, address: PROXY }, { route: { backend: "etherscan-v2" } }),
      (error: unknown) => error instanceof ExplorerVerifyError && error.code === "missing-api-key",
    );
    assert.equal(sent.length, 0);
  });

  it("throws unsupported-chain for Etherscan's unsupported chain answer", async (t) => {
    const r = await run(
      t,
      [etherscanText("Missing or unsupported chainid parameter (required for v2 api)")],
      ETHERSCAN_OPTIONS,
    );
    errorOf(r, "unsupported-chain");
  });

  it("ends with proxy-link-pending when a status request that is not JSON leaves no budget", async (t) => {
    const r = await run(t, [REQUESTED(), new Response("oops", { status: 404 })], {
      ...ETHERSCAN_OPTIONS,
      timeoutMs: 4_000,
    });
    const error = errorOf(r, "proxy-link-pending");
    assert.ok(error.cause instanceof Error);
  });

  it("rejects with the abort reason when the signal aborts while a check waits", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const controller = new AbortController();
    const reason = new Error("stop");
    const fake = replay(REQUESTED(), PENDING_0(), PENDING_0(), PENDING_0());
    const call = runLinkProxy(
      { chainId: SEPOLIA, address: PROXY },
      { ...ETHERSCAN_OPTIONS, fetch: fake.fetch, signal: controller.signal },
      DEFAULT_LINK_DEPENDENCIES,
    );
    await driveMockClock(call, () => {
      if (fake.calls.length >= 2) {
        controller.abort(reason);
      }
      t.mock.timers.runAll();
    });
    await assert.rejects(call, (error: unknown) => error === reason);
  });
});

describe("linkProxy() on a standalone Etherscan-compatible explorer (R-FLOW-8)", () => {
  it("links with route.apiKey in the body, and no chainid", async (t) => {
    const r = await run(
      t,
      [REQUESTED(), LINKED()],
      {
        route: {
          backend: "etherscan-compatible",
          apiUrl: "http://127.0.0.1:8555/api",
          apiKey: ROUTE_KEY,
        },
      },
      { chainId: 296, address: PROXY },
    );
    assert.deepEqual(resultOf(r), {
      status: "linked",
      backend: "etherscan-compatible",
      implementation: BOX,
      implementationVerified: true,
    });
    assert.equal(r.calls[0]?.url, "http://127.0.0.1:8555/api");
    assert.equal(new URLSearchParams(r.calls[0]?.body).get("apikey"), ROUTE_KEY);
    assert.ok(!visible(r).includes(ROUTE_KEY));
  });

  it("is the compatible linker that the default dependencies load", async () => {
    const load = DEFAULT_LINK_DEPENDENCIES.linkers["etherscan-compatible"];
    assert.ok(typeof load === "function");
    assert.equal(await load(), compatibleProxyLinker);
  });

  it("loads the Blockscout linker for both blockscout and blockscout-hosted (decision 0041)", async () => {
    for (const backend of ["blockscout", "blockscout-hosted"] as const) {
      const load = DEFAULT_LINK_DEPENDENCIES.linkers[backend];
      assert.ok(typeof load === "function");
      assert.equal(await load(), blockscoutProxyLinker);
    }
  });
});

describe("linkProxy() on a Blockscout instance (R-FLOW-8)", () => {
  it("links with recorded answers, then reads whether the implementation is verified", async (t) => {
    const r = await run(
      t,
      [
        ACCEPTED(),
        blockscout("2026-11-04-checkproxyverification-in-progress"),
        BS_LINKED(),
        LOOKUP_VERIFIED(),
      ],
      BLOCKSCOUT_OPTIONS,
    );
    // The table lists this instance for Sepolia since #169, so the result has its page.
    assert.deepEqual(resultOf(r), {
      status: "linked",
      backend: "blockscout",
      implementation: BOX,
      implementationVerified: true,
      explorerUrl: `https://eth-sepolia.blockscout.com/address/${PROXY}?tab=contract`,
    });
    assert.deepEqual(
      r.calls.map((call) => [call.method, call.url, new URLSearchParams(call.body).get("action")]),
      [
        ["POST", BLOCKSCOUT_API, "verifyproxycontract"],
        ["POST", BLOCKSCOUT_API, "checkproxyverification"],
        ["POST", BLOCKSCOUT_API, "checkproxyverification"],
        ["GET", `${BLOCKSCOUT_API}/v2/smart-contracts/${BOX}`, null],
      ],
    );
    assert.ok(r.calls.every((call) => !(call.body ?? "").includes("apikey")));
  });

  it("reports an implementation Blockscout has not verified", async (t) => {
    const r = await run(t, [ACCEPTED(), BS_LINKED(), LOOKUP_UNVERIFIED()], BLOCKSCOUT_OPTIONS);
    const result = resultOf(r);
    assert.equal(result.status === "linked" && result.implementationVerified, false);
  });

  it("gives not-linked for a proxy Blockscout has not verified", async (t) => {
    const r = await run(
      t,
      [blockscout("2026-11-04-verifyproxycontract-proxy-not-verified")],
      BLOCKSCOUT_OPTIONS,
      { chainId: SEPOLIA, address: OTHER_PROXY },
    );
    assert.deepEqual(resultOf(r), {
      status: "not-linked",
      backend: "blockscout",
      reason: "Smart-contract not found or is not verified",
    });
  });

  it("gives not-linked when Blockscout detects no implementation, or none at all", async (t) => {
    const reason =
      "A corresponding implementation contract was unfortunately not detected for the proxy address.";
    const r = await run(
      t,
      [ACCEPTED(), json({ status: "0", message: "NOTOK", result: reason })],
      BLOCKSCOUT_OPTIONS,
    );
    assert.deepEqual(resultOf(r), { status: "not-linked", backend: "blockscout", reason });
    const empty = await run(
      t,
      [
        ACCEPTED(),
        json({
          status: "1",
          message: "OK",
          result: `The proxy's (${PROXY}) implementation contracts are found at [] and they've been successfully updated.`,
        }),
      ],
      BLOCKSCOUT_OPTIONS,
    );
    assert.deepEqual(resultOf(empty), {
      status: "not-linked",
      backend: "blockscout",
      reason: "Blockscout detects no implementation for the proxy.",
    });
  });

  it("gives mismatch when the implementation is not the expected one, with no lookup", async (t) => {
    const r = await run(t, [ACCEPTED(), BS_LINKED()], BLOCKSCOUT_OPTIONS, {
      chainId: SEPOLIA,
      address: PROXY,
      expectedImplementation: GREETER,
    });
    assert.deepEqual(resultOf(r), {
      status: "mismatch",
      backend: "blockscout",
      implementation: BOX,
      expectedImplementation: GREETER,
    });
    assert.equal(r.calls.length, 2);
  });

  it("waits the interval once after Only one attempt, as right after verify(), then links", async (t) => {
    const r = await run(
      t,
      [ONE_ATTEMPT(), ACCEPTED(), BS_LINKED(), LOOKUP_VERIFIED()],
      BLOCKSCOUT_OPTIONS,
    );
    assert.equal(resultOf(r).status, "linked");
    assert.deepEqual(actions(r).slice(0, 2), ["verifyproxycontract", "verifyproxycontract"]);
    assert.equal(r.times[1], 12_000);
  });

  it("reads the implementation Blockscout holds when the second request is refused too", async (t) => {
    const r = await run(
      t,
      [
        ONE_ATTEMPT(),
        ONE_ATTEMPT(),
        blockscout("2026-11-04-lookup-box-proxy-before"),
        LOOKUP_UNVERIFIED(),
      ],
      BLOCKSCOUT_OPTIONS,
    );
    assert.deepEqual(resultOf(r), {
      status: "linked",
      backend: "blockscout",
      implementation: BOX,
      implementationVerified: false,
      explorerUrl: `https://eth-sepolia.blockscout.com/address/${PROXY}?tab=contract`,
    });
    assert.deepEqual(actions(r), [
      "verifyproxycontract",
      "verifyproxycontract",
      `${BLOCKSCOUT_API}/v2/smart-contracts/${PROXY}`,
      `${BLOCKSCOUT_API}/v2/smart-contracts/${BOX}`,
    ]);
  });

  it("reads the record at once when the interval does not fit the budget", async (t) => {
    const r = await run(
      t,
      [ONE_ATTEMPT(), proxyLookup([{ address_hash: BOX }]), LOOKUP_VERIFIED()],
      { ...BLOCKSCOUT_OPTIONS, timeoutMs: 5_000 },
    );
    assert.equal(resultOf(r).status, "linked");
    assert.equal(r.times[1], 0);
  });

  it("maps the record: none is not-linked, several or a bad address unknown, another form unexpected", async (t) => {
    const empty = await run(t, [ONE_ATTEMPT(), ONE_ATTEMPT(), proxyLookup([])], BLOCKSCOUT_OPTIONS);
    assert.equal(resultOf(empty).status, "not-linked");
    for (const implementations of [
      [{ address_hash: BOX }, { address_hash: GREETER }],
      [{ address_hash: ZERO }],
      [{ address_hash: LONG }],
      [null],
    ]) {
      const r = await run(
        t,
        [ONE_ATTEMPT(), ONE_ATTEMPT(), proxyLookup(implementations)],
        BLOCKSCOUT_OPTIONS,
      );
      unknownLinkState(r, "blockscout");
    }
    for (const answer of [json({ message: "Not found" }, 404), json({ implementations: "x" })]) {
      const r = await run(t, [ONE_ATTEMPT(), ONE_ATTEMPT(), answer], BLOCKSCOUT_OPTIONS);
      errorOf(r, "unexpected-response");
    }
  });

  it("ends with proxy-link-pending for an address that stays in progress, as the Greeter did live", async (t) => {
    const inProgress = Array.from({ length: 10 }, () =>
      blockscout("2026-11-04-checkproxyverification-in-progress"),
    );
    const r = await run(
      t,
      [blockscout("2026-11-04-verifyproxycontract-not-a-proxy"), ...inProgress],
      { ...BLOCKSCOUT_OPTIONS, timeoutMs: 10_000 },
      { chainId: SEPOLIA, address: GREETER },
    );
    errorOf(r, "proxy-link-pending");
  });

  it("throws proxy-link-unknown-state for Unknown UID, unknown texts and implementations that are not one address", async (t) => {
    for (const result of [
      undefined,
      "Something new",
      foundText(LONG),
      foundText(ZERO),
      foundText(BOX, GREETER),
      `The proxy's (${PROXY}) implementation contracts are found at [${BOX}, ${GREETER}] and they've been successfully updated.`,
    ]) {
      const answer =
        result === undefined
          ? blockscout("2026-11-04-checkproxyverification-unknown-uid")
          : json({ status: "1", message: "OK", result });
      const r = await run(t, [ACCEPTED(), answer], BLOCKSCOUT_OPTIONS);
      unknownLinkState(r, "blockscout");
    }
  });

  it("throws unexpected-response at request time for an answer that is not a uid of the documented form", async (t) => {
    for (const answer of [
      json({ status: "0", message: "Invalid address hash", result: null }),
      json({ status: "0", message: "Only one attempt in soon", result: null }),
      json({ status: "0", result: null }),
      json({ status: "1", message: "OK", result: null }),
      json({ status: "1", message: "OK", result: "OK" }),
      json({ status: "1", message: "OK", result: `${GREETER.slice(2)}6aeb80cb` }),
      json({ status: "1", message: "OK", result: PROXY.slice(2) }),
    ]) {
      const r = await run(t, [answer], { ...BLOCKSCOUT_OPTIONS, timeoutMs: 1_000 });
      errorOf(r, "unexpected-response");
      assert.equal(r.calls.length, 1);
    }
  });

  it("treats a check answered with a server error as a failed check", async (t) => {
    const r = await run(
      t,
      [ACCEPTED(), new Response("{}", { status: 404 }), BS_LINKED(), LOOKUP_VERIFIED()],
      BLOCKSCOUT_OPTIONS,
    );
    assert.equal(resultOf(r).status, "linked");
  });

  it("waits the interval when the context has no budget, as a direct call does", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const fake = replay(ONE_ATTEMPT(), ACCEPTED());
    const ctx: Context = {
      route: resolveRoute(SEPOLIA, { backend: "blockscout", apiUrl: BLOCKSCOUT_API }),
      http: { backend: "blockscout", secrets: [], fetch: fake.fetch },
    };
    const step = blockscoutProxyLinker.request({ chainId: SEPOLIA, address: PROXY }, ctx);
    await driveMockClock(step, () => {
      t.mock.timers.runAll();
    });
    assert.equal((await step).state, "submitted");
  });

  it("verified() is false for an implementation the instance has not verified", async () => {
    const fake = replay(LOOKUP_UNVERIFIED());
    const ctx: Context = {
      route: resolveRoute(SEPOLIA, { backend: "blockscout", apiUrl: BLOCKSCOUT_API }),
      http: { backend: "blockscout", secrets: [], fetch: fake.fetch },
    };
    assert.equal(await blockscoutProxyLinker.verified?.(BOX, SEPOLIA, ctx), false);
  });
});

describe("linkProxy() on Sourcify (R-FLOW-8)", () => {
  it("reads the link with one lookup, then the implementation's match", async (t) => {
    const r = await run(
      t,
      [sourcify("2026-11-04-proxy-resolution-box-proxy"), BOX_VERIFIED()],
      SOURCIFY_OPTIONS,
    );
    assert.deepEqual(resultOf(r), {
      status: "linked",
      backend: "sourcify",
      implementation: BOX,
      implementationVerified: true,
      explorerUrl: `https://repo.sourcify.dev/${String(SEPOLIA)}/${PROXY}`,
    });
    assert.deepEqual(actions(r), [
      `https://sourcify.dev/server/v2/contract/${String(SEPOLIA)}/${PROXY}?fields=proxyResolution`,
      `https://sourcify.dev/server/v2/contract/${String(SEPOLIA)}/${BOX}`,
    ]);
  });

  it("reports an implementation Sourcify has not verified", async (t) => {
    const r = await run(
      t,
      [sourcify("2026-11-04-proxy-resolution-box-proxy"), sourcify("2026-11-04-lookup-box")],
      SOURCIFY_OPTIONS,
    );
    const result = resultOf(r);
    assert.equal(result.status === "linked" && result.implementationVerified, false);
  });

  it("gives mismatch for another implementation than expected, with no second lookup", async (t) => {
    const r = await run(t, [sourcify("2026-11-04-proxy-resolution-box-proxy")], SOURCIFY_OPTIONS, {
      chainId: SEPOLIA,
      address: PROXY,
      expectedImplementation: GREETER,
    });
    assert.deepEqual(resultOf(r), {
      status: "mismatch",
      backend: "sourcify",
      implementation: BOX,
      expectedImplementation: GREETER,
    });
    assert.equal(r.calls.length, 1);
  });

  it("gives not-linked for a non-proxy, a proxy not verified, and a proxy with no implementation", async (t) => {
    const notProxy = await run(
      t,
      [sourcify("2026-11-04-proxy-resolution-not-a-proxy")],
      SOURCIFY_OPTIONS,
      { chainId: SEPOLIA, address: GREETER },
    );
    assert.deepEqual(resultOf(notProxy), {
      status: "not-linked",
      backend: "sourcify",
      reason: "Sourcify does not detect a proxy at the address.",
    });
    const notVerified = await run(
      t,
      [sourcify("2026-11-04-proxy-resolution-not-verified")],
      SOURCIFY_OPTIONS,
      { chainId: SEPOLIA, address: OTHER_PROXY },
    );
    assert.equal(resultOf(notVerified).status, "not-linked");
    const none = await run(
      t,
      [resolution({ isProxy: true, implementations: [] })],
      SOURCIFY_OPTIONS,
    );
    assert.deepEqual(resultOf(none), {
      status: "not-linked",
      backend: "sourcify",
      reason: "Sourcify detects no implementation for the proxy.",
    });
  });

  it("throws proxy-link-unknown-state for implementations that are not one address", async (t) => {
    for (const implementations of [
      [{ address: BOX }, { address: GREETER }],
      [{ address: ZERO }],
      [{ address: LONG }],
      [{ address: "0x12" }],
      [null],
    ]) {
      const r = await run(t, [resolution({ isProxy: true, implementations })], SOURCIFY_OPTIONS);
      unknownLinkState(r, "sourcify");
    }
  });

  it("throws unexpected-response for an answer it does not know", async (t) => {
    for (const answer of [
      resolution({ isProxy: true }),
      resolution({ isProxy: "yes", implementations: [{ address: BOX }] }),
      resolution(null),
      json({ match: null, proxyResolution: { isProxy: false } }),
      json({ proxyResolution: { isProxy: false } }, 404),
      json({ match: "exact_match" }),
    ]) {
      const r = await run(t, [answer], SOURCIFY_OPTIONS);
      errorOf(r, "unexpected-response");
    }
  });

  it("check() reads the link again", async () => {
    const fake = replay(sourcify("2026-11-04-proxy-resolution-not-a-proxy"));
    const verdict = await sourcifyProxyLinker.check(
      "unused",
      { chainId: SEPOLIA, address: GREETER },
      {
        route: resolveRoute(SEPOLIA, { backend: "sourcify" }),
        http: { backend: "sourcify", secrets: [], fetch: fake.fetch },
      },
    );
    assert.equal(verdict.state, "not-linked");
  });
});

describe("linkProxy() checks the target and the route first", () => {
  it("throws invalid-input naming each bad field, and sends nothing", async (t) => {
    const cases: [unknown, string[]][] = [
      [null, ["target"]],
      [[PROXY], ["target"]],
      [{}, ["chainId", "address"]],
      [{ chainId: 0, address: PROXY }, ["chainId"]],
      [{ chainId: SEPOLIA, address: "0x12" }, ["address"]],
      [
        { chainId: SEPOLIA, address: PROXY, expectedImplementation: null },
        ["expectedImplementation"],
      ],
    ];
    for (const [target, fields] of cases) {
      const r = await run(t, [], ETHERSCAN_OPTIONS, target);
      const error = errorOf(r, "invalid-input");
      assert.deepEqual(
        error.details.code === "invalid-input" && error.details.issues.map((issue) => issue.field),
        fields,
      );
      assert.equal(r.calls.length, 0);
    }
  });

  it("ignores a field the target does not declare, as verify() ignores one in its input", async (t) => {
    const r = await run(t, [REQUESTED(), LINKED()], ETHERSCAN_OPTIONS, {
      chainId: SEPOLIA,
      address: PROXY,
      implementation: GREETER,
    });
    assert.equal(resultOf(r).status, "linked");
  });

  it("throws invalid-input on route.backend for Routescan before routing, with no request", async (t) => {
    const r = await run(
      t,
      [],
      { route: { backend: "routescan" } },
      {
        chainId: SEPOLIA,
        address: PROXY,
      },
    );
    const error = errorOf(r, "invalid-input");
    assert.deepEqual(error.details.code === "invalid-input" && error.details.issues, [
      { field: "route.backend", message: "routescan cannot link a proxy" },
    ]);
    assert.match(error.hint, /etherscan-compatible/);
    assert.equal(r.calls.length, 0);
  });

  it("throws invalid-input when the routing table picks a backend with no proxy-link code", async (t) => {
    const r = await run(t, [], {}, { chainId: SEPOLIA, address: PROXY }, { linkers: {} });
    const error = errorOf(r, "invalid-input");
    assert.equal(
      error.details.code === "invalid-input" && error.details.issues[0]?.field,
      "route.backend",
    );
  });

  it("throws invalid-input for bad options before reading the target", async () => {
    await assert.rejects(
      linkProxy({ chainId: SEPOLIA, address: PROXY }, { timeoutMs: -1 }),
      (error: unknown) => error instanceof ExplorerVerifyError && error.code === "invalid-input",
    );
  });

  it("rejects at once when the signal has aborted", async () => {
    const reason = new Error("early");
    await assert.rejects(
      linkProxy({ chainId: SEPOLIA, address: PROXY }, { signal: AbortSignal.abort(reason) }),
      (error: unknown) => error === reason,
    );
  });
});

describe("linkProxy() with linkers passed in", () => {
  const target: LinkProxyTarget = { chainId: SEPOLIA, address: PROXY };

  it("uses a linker object as it is, and reports false when nothing says the implementation is verified", async (t) => {
    const r = await run(t, [], SOURCIFY_OPTIONS, target, {
      linkers: { sourcify: linker({ state: "linked", implementation: BOX }) },
    });
    const result = resultOf(r);
    assert.equal(result.status === "linked" && result.implementationVerified, false);
  });

  it("throws proxy-link-pending when the request answers pending", async (t) => {
    const r = await run(t, [], SOURCIFY_OPTIONS, target, {
      linkers: { sourcify: linker({ state: "pending" }) },
      random: () => 0,
    });
    errorOf(r, "proxy-link-pending");
  });

  it("passes on an error a check throws that is not an ExplorerVerifyError", async (t) => {
    const failing: ProxyLinker = {
      request: submitted,
      check: async () => await Promise.reject(new Error("bug")),
    };
    const r = await run(t, [], SOURCIFY_OPTIONS, target, { linkers: { sourcify: failing } });
    assert.ok(r.outcome.error instanceof Error && r.outcome.error.message === "bug");
  });

  it("throws proxy-link-pending when a check throws timeout", async (t) => {
    const timingOut: ProxyLinker = {
      request: submitted,
      check: async () =>
        await Promise.reject(
          new ExplorerVerifyError({ code: "timeout", backend: "sourcify", timeoutMs: 1 }, "late", {
            secrets: [],
          }),
        ),
    };
    const r = await run(t, [], SOURCIFY_OPTIONS, target, { linkers: { sourcify: timingOut } });
    errorOf(r, "proxy-link-pending");
  });

  it("passes on any other check error at once", async (t) => {
    const busy: ProxyLinker = {
      request: submitted,
      check: async () =>
        await Promise.reject(
          new ExplorerVerifyError({ code: "in-progress", backend: "sourcify" }, "busy", {
            secrets: [],
          }),
        ),
    };
    const r = await run(t, [], SOURCIFY_OPTIONS, target, { linkers: { sourcify: busy } });
    errorOf(r, "in-progress");
  });

  it("rejects with the abort reason when a check fails as the signal aborts", async (t) => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const aborting: ProxyLinker = {
      request: submitted,
      check: async () => {
        controller.abort(reason);
        return await Promise.reject(
          new ExplorerVerifyError({ code: "network", backend: "sourcify", attempts: 1 }, "down", {
            secrets: [],
          }),
        );
      },
    };
    const r = await run(t, [], { ...SOURCIFY_OPTIONS, signal: controller.signal }, target, {
      linkers: { sourcify: aborting },
    });
    assert.equal(r.outcome.error, reason);
  });

  it("rejects with the loader's error when the proxy-link code fails to load", async (t) => {
    const failure = new Error("chunk failed");
    const r = await run(t, [], SOURCIFY_OPTIONS, target, {
      linkers: { sourcify: async () => await Promise.reject(failure) },
    });
    assert.equal(r.outcome.error, failure);
  });

  it("routes with the table passed in", async (t) => {
    const r = await run(
      t,
      [],
      {},
      { chainId: 999_999_999, address: PROXY },
      {
        linkers: { sourcify: linker({ state: "not-linked", reason: "no" }) },
        table: { schemaVersion: 2, checked: "2026-11-04", chains: [] },
      },
    );
    errorOf(r, "unsupported-chain");
  });
});

/** A recorded answer whose `url` says it came from `url`, as a real fetch's answer does. */
function answeredFrom(url: string, name: string): Response {
  const answer = responseOf(loadFixture("etherscan", name));
  Object.defineProperty(answer, "url", { value: url });
  return answer;
}

/**
 * Runs linkProxy() on mock timers with an injected fetch that returns `answers` as they are, not
 * cloned, so their `url` and `redirected` reach the HTTP layer. Returns the result or the error and
 * the `action` of each request.
 */
async function throughHandler(
  t: TestContext,
  answers: Response[],
): Promise<{ outcome: unknown; actions: string[] }> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const sent: string[] = [];
  const viaHandler: typeof fetch = async (_input, init) => {
    const body = init?.body;
    const form = new URLSearchParams(
      typeof body === "string" || body instanceof URLSearchParams ? body : "",
    );
    sent.push(form.get("action") ?? "");
    const next = answers.shift();
    if (next === undefined) {
      throw new Error("unexpected request");
    }
    return await Promise.resolve(next);
  };
  const call = runLinkProxy(
    { chainId: SEPOLIA, address: PROXY },
    {
      timeoutMs: 20_000,
      pollIntervalMs: 3_000,
      handlerUrl: "https://dapp.example/api/verify",
      fetch: viaHandler,
    },
    DEFAULT_LINK_DEPENDENCIES,
  );
  await driveMockClock(call, () => {
    t.mock.timers.runAll();
  });
  const outcome: unknown = await call.catch((error: unknown) => error);
  return { outcome, actions: sent };
}

// Decision 0035: linkProxy() gets the platform's fetch as its default, so an answer from another
// origin than the request is refused there; an injected fetch may send the request to a server
// handler on purpose, so the URL of its answer is not checked.
describe("linkProxy(): the origin of an answer (R-SEC-2, decision 0035)", () => {
  const HANDLER = "https://dapp.example/api/verify";

  it("refuses an answer from another origin through the default fetch, without a retry", async (t) => {
    const sent: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      sent.push(input instanceof Request ? input.url : String(input));
      return await Promise.resolve(answeredFrom(HANDLER, "2026-11-04-verifyproxycontract-linked"));
    });
    await assert.rejects(
      linkProxy({ chainId: SEPOLIA, address: PROXY }, ETHERSCAN_OPTIONS),
      (error: unknown) => {
        assert.ok(error instanceof ExplorerVerifyError);
        assert.equal(error.code, "unexpected-response");
        assert.match(error.message, /redirect, which is not followed/);
        return true;
      },
    );
    assert.deepEqual(sent, [`https://api.etherscan.io/v2/api?chainid=${String(SEPOLIA)}`]);
  });

  it("links through an injected fetch whose answers come from a server handler", async (t) => {
    const { outcome, actions: sent } = await throughHandler(t, [
      answeredFrom(HANDLER, "2026-11-04-verifyproxycontract-linked"),
      answeredFrom(HANDLER, "2026-11-04-checkproxyverification-linked"),
    ]);
    assert.ok(!(outcome instanceof Error), String(outcome));
    assert.equal(Reflect.get(Object(outcome), "status"), "linked");
    assert.deepEqual(sent, ["verifyproxycontract", "checkproxyverification"]);
  });

  it("links through handlerUrl with the platform's fetch: requests go to the handler, its answers are kept (decision 0046)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const sent: string[] = [];
    const answers = [
      answeredFrom(HANDLER, "2026-11-04-verifyproxycontract-linked"),
      answeredFrom(HANDLER, "2026-11-04-checkproxyverification-linked"),
    ];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      assert.ok(body instanceof URLSearchParams);
      assert.equal(body.get("apikey"), null);
      sent.push(
        `${input instanceof Request ? input.url : String(input)} ${String(body.get("action"))}`,
      );
      const next = answers.shift();
      assert.ok(next !== undefined, "unexpected request");
      return await Promise.resolve(next);
    });
    const call = linkProxy(
      { chainId: SEPOLIA, address: PROXY },
      { timeoutMs: 20_000, pollIntervalMs: 3_000, handlerUrl: HANDLER },
    );
    await driveMockClock(call, () => {
      t.mock.timers.runAll();
    });
    const outcome = await call;
    assert.equal(outcome.status, "linked");
    assert.deepEqual(sent, [
      `${HANDLER}?chainid=${String(SEPOLIA)} verifyproxycontract`,
      `${HANDLER}?chainid=${String(SEPOLIA)} checkproxyverification`,
    ]);
  });

  it("still refuses an answer marked redirected through an injected fetch", async (t) => {
    const answer = answeredFrom(HANDLER, "2026-11-04-verifyproxycontract-linked");
    Object.defineProperty(answer, "redirected", { value: true });
    const { outcome, actions: sent } = await throughHandler(t, [answer]);
    assert.ok(outcome instanceof ExplorerVerifyError);
    assert.equal(outcome.code, "unexpected-response");
    assert.deepEqual(sent, ["verifyproxycontract"]);
  });
});
