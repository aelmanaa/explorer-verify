// Tests for decision 0073: `route.explorerUrl` (#389), the `failed` result's `reasonCode` in the
// envelope (#390), the `verify.stored` event (#391) and the display labels (#392). The clients'
// reason codes are tested with each client's recorded answers in its own test file.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKEND_LABELS, BACKEND_NAMES } from "../../src/backend-names.ts";
import * as backends from "../../src/entries/backends.ts";
import { toEnvelope } from "../../src/envelope.ts";
import { DEFAULT_DEPENDENCIES } from "../../src/flow/defaults.ts";
import { ExplorerVerifyError, dryRun } from "../../src/index.ts";
import type {
  RouteOverride,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../../src/index.ts";
import { redactEvent } from "../../src/observe.ts";
import { pageAt } from "../../src/routing/resolve.ts";
import { runVerify as runWith } from "../helpers/defaults.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import { resolveRoute } from "../helpers/route.ts";
import { validateEnvelope } from "./envelope-schema.ts";

const SEPOLIA = 11155111;
// The Greeter deployed on Sepolia on 2026-11-02, whose responses the fixtures recorded.
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const ADDRESS = "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC";

async function runVerify(value: VerifyInput, options: VerifyOptions): Promise<VerifyResult> {
  return await runWith(value, options, DEFAULT_DEPENDENCIES);
}

function input(): VerifyInput {
  return {
    chainId: SEPOLIA,
    address: ADDRESS,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "src/Greeter.sol": { content: "contract Greeter {}" } },
        settings: {},
      },
    },
    contractName: "src/Greeter.sol:Greeter",
  };
}

/** The error `work` throws. */
function thrown(work: () => unknown): ExplorerVerifyError {
  try {
    work();
  } catch (error: unknown) {
    assert.ok(error instanceof ExplorerVerifyError, String(error));
    return error;
  }
  return assert.fail("expected an ExplorerVerifyError");
}

/** A route override whose `explorerUrl` is any value, as untyped code may pass it. */
function withExplorerUrl(value: unknown): RouteOverride {
  const route: RouteOverride = {};
  Reflect.set(route, "explorerUrl", value);
  return route;
}

describe("BACKEND_LABELS (#392, decision 0073)", () => {
  it("names every backend and is exported from explorer-verify/backends", () => {
    assert.deepEqual(Object.keys(BACKEND_LABELS).toSorted(), [...BACKEND_NAMES].toSorted());
    assert.equal(backends.BACKEND_LABELS, BACKEND_LABELS);
    assert.deepEqual(
      BACKEND_NAMES.map((name) => BACKEND_LABELS[name]),
      [
        "Etherscan",
        "Etherscan-compatible explorer",
        "Blockscout",
        "Blockscout",
        "Sourcify",
        "Routescan",
      ],
    );
  });

  it("names the explorer in a message and keeps the id in details.backend", () => {
    const error = thrown(() => resolveRoute(SEPOLIA, { backend: "etherscan-compatible" }));
    assert.equal(
      error.message,
      "The routing table lists no Etherscan-compatible explorer API for chain 11155111.",
    );
    assert.ok(error.details.code === "unsupported-chain");
    assert.equal(error.details.backend, "etherscan-compatible");
  });
});

describe("route.explorerUrl (#389, decision 0073)", () => {
  it("builds each backend's page as the routing table does", () => {
    const base = "https://explorer.example.org";
    assert.equal(pageAt(base, "etherscan-v2", 1)(GREETER), `${base}/address/${GREETER}#code`);
    assert.equal(
      pageAt(base, "etherscan-compatible", 1)(GREETER),
      `${base}/address/${GREETER}#code`,
    );
    assert.equal(pageAt(base, "routescan", 1)(GREETER), `${base}/address/${GREETER}#code`);
    assert.equal(pageAt(base, "blockscout", 1)(GREETER), `${base}/address/${GREETER}?tab=contract`);
    assert.equal(
      pageAt(base, "blockscout-hosted", 1)(GREETER),
      `${base}/address/${GREETER}?tab=contract`,
    );
    assert.equal(
      pageAt(base, "sourcify", SEPOLIA)(GREETER),
      `${base}/${String(SEPOLIA)}/${GREETER}`,
    );
  });

  it("gives a route with apiUrl a page, without trailing slashes", () => {
    const route = resolveRoute(31337, {
      backend: "blockscout",
      apiUrl: "http://127.0.0.1:4000/api",
      explorerUrl: "http://localhost:4000//",
    });
    assert.equal(
      route.explorerUrl?.(GREETER),
      `http://localhost:4000/address/${GREETER}?tab=contract`,
    );
    // Without it, the same route has no page.
    const bare = resolveRoute(31337, {
      backend: "blockscout",
      apiUrl: "http://127.0.0.1:4000/api",
    });
    assert.equal(bare.explorerUrl, undefined);
  });

  it("replaces the routing table's page", () => {
    const route = resolveRoute(SEPOLIA, {
      backend: "sourcify",
      explorerUrl: "https://sourcify.dev/server/repo-ui",
    });
    assert.equal(
      route.explorerUrl?.(GREETER),
      `https://sourcify.dev/server/repo-ui/${String(SEPOLIA)}/${GREETER}`,
    );
  });

  it("refuses what route.apiUrl refuses, and a query string, without repeating the value", () => {
    const secret = "DUMMYSECRETexplorerurl389";
    const cases: readonly [unknown, string][] = [
      [42, "must be a string"],
      ["not a url", "must be an absolute URL"],
      ["http://explorer.example.org", "must use https, or http on localhost, 127.0.0.1 or [::1]"],
      [`https://user:${secret}@explorer.example.org`, "must not contain a user name or password"],
      ["https://explorer.example.org/#code", "must not contain a fragment"],
      [`https://explorer.example.org/?token=${secret}`, "must not contain a query string"],
      [`https://explorer.example.org/${"a".repeat(8192)}`, "must be at most 8192 characters"],
    ];
    for (const [explorerUrl, message] of cases) {
      const error = thrown(() => resolveRoute(SEPOLIA, withExplorerUrl(explorerUrl)));
      assert.ok(error.details.code === "invalid-input");
      assert.deepEqual(error.details.issues, [{ field: "route.explorerUrl", message }]);
      assert.match(error.hint, /page base/);
      assert.ok(!JSON.stringify(error).includes(secret), JSON.stringify(error));
    }
  });

  it("reaches the result of verify() and dryRun()", async () => {
    const route = {
      backend: "sourcify",
      apiUrl: "http://127.0.0.1:5555",
      explorerUrl: "https://repo.example.org",
    } as const;
    const page = `https://repo.example.org/${String(SEPOLIA)}/${GREETER}`;
    const verified = await runVerify(input(), {
      fetch: replay(loadFixture("sourcify", "2026-11-02-lookup-exact-match")).fetch,
      route,
    });
    assert.deepEqual(verified, {
      status: "already-verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: page,
    });
    const dry = await dryRun(input(), {
      fetch: replay(loadFixture("sourcify", "2026-11-02-lookup-exact-match")).fetch,
      route,
    });
    assert.equal(dry.explorerUrl, page);
  });
});

describe("verify.stored (#391, decision 0073)", () => {
  it("is not emitted for a match of this source", async () => {
    const events: VerifyEvent[] = [];
    await runVerify(input(), {
      fetch: replay(loadFixture("sourcify", "2026-11-02-lookup-exact-match")).fetch,
      onEvent: (event) => {
        events.push(event);
      },
    });
    assert.deepEqual(
      events.map((event) => event.type),
      ["verify.validated", "verify.routed", "verify.lookup", "verify.result"],
    );
  });
});

describe("reasonCode in the envelope (#390, decision 0073)", () => {
  const failed: VerifyResult = {
    status: "failed",
    backend: "sourcify",
    reason: "missing_source: x",
    reasonCode: "missing-source",
  };

  it("is kept, last in the result, and the schema accepts it", () => {
    const envelope = toEnvelope(failed);
    assert.deepEqual(envelope.result, failed);
    assert.deepEqual(validateEnvelope(envelope), []);
  });

  it("reads a result from an older copy without one, or a newer copy's value, as unknown", () => {
    const older = { ...failed };
    Reflect.deleteProperty(older, "reasonCode");
    assert.deepEqual(toEnvelope(older).result, { ...failed, reasonCode: "unknown" });
    const newer = { ...failed };
    Reflect.set(newer, "reasonCode", "some-later-code");
    assert.deepEqual(toEnvelope(newer).result, { ...failed, reasonCode: "unknown" });
  });
});

describe("verify.stored after redaction (#391, decision 0073)", () => {
  const secret = "0123456789abcdef0123456789abcdef";

  it("leaves out name and compilerVersion when the explorer gave none", () => {
    const event = redactEvent({ type: "verify.stored", backend: "sourcify" }, [secret]);
    assert.deepEqual(event, { type: "verify.stored", backend: "sourcify" });
    assert.equal("name" in event, false);
    assert.equal("compilerVersion" in event, false);
  });

  it("keeps name and compilerVersion, each redacted", () => {
    const event = redactEvent(
      {
        type: "verify.stored",
        backend: "blockscout",
        name: `Vault ${secret}`,
        compilerVersion: `0.8.26 ${secret}`,
      },
      [secret],
    );
    assert.equal(event.type, "verify.stored");
    assert.ok("name" in event && typeof event.name === "string" && !event.name.includes(secret));
    assert.ok(
      "compilerVersion" in event &&
        typeof event.compilerVersion === "string" &&
        !event.compilerVersion.includes(secret),
    );
  });
});
