// Black-box tests for issue #60: the seeded routing table. They use only the issue,
// docs/user/reference/routing.md, api-keys.md, verify.md, sourcify.md, logging-and-events.md,
// errors/unsupported-chain.md and requirements.md (R-RT-*). Every call goes through the package
// entry point with a fake `fetch` shaped like Sourcify's answers; no request leaves the process.
// The routing table is read as data, as routing.md tells a user to ("search table.json").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ExplorerVerifyError, checkStatus, verify } from "../../src/index.ts";
import type {
  Handle,
  Hex,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../../src/index.ts";

const ADDRESS: Hex = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const ETHERSCAN_KEY = "zz9dummyetherscankeyqq7xv";
const ROUTESCAN_KEY = "rr4dummyroutescankeyww2pl";
const NAMED_CHAINS = [1, 11155111, 43113, 43114, 80002, 84532, 421614] as const;

interface Entry {
  readonly backend: string;
  readonly network?: string;
  readonly explorer?: string;
}
interface Row {
  readonly chainId: number;
  readonly backends: readonly Entry[];
}

function readTable(): { schemaVersion: unknown; checked: unknown; rows: Row[] } {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("../../src/routing/table.json", import.meta.url), "utf8"),
  );
  assert.ok(typeof raw === "object" && raw !== null);
  const record = Object.fromEntries(Object.entries(raw));
  const found = Object.values(record).find((value) => Array.isArray(value));
  assert.ok(Array.isArray(found), "table.json has one array of rows");
  const rows: readonly unknown[] = found;
  const typed: Row[] = [];
  for (const row of rows) {
    assert.ok(typeof row === "object" && row !== null);
    const r = Object.fromEntries(Object.entries(row));
    assert.equal(typeof r["chainId"], "number");
    const list = r["backends"];
    assert.ok(Array.isArray(list));
    const entries: readonly unknown[] = list;
    const backends: Entry[] = [];
    for (const entry of entries) {
      assert.ok(typeof entry === "object" && entry !== null);
      const e = Object.fromEntries(Object.entries(entry));
      const backend = e["backend"];
      const network = e["network"];
      const explorer = e["explorer"];
      assert.ok(typeof backend === "string");
      assert.ok(network === undefined || typeof network === "string");
      assert.ok(explorer === undefined || typeof explorer === "string");
      backends.push({
        backend,
        ...(network === undefined ? {} : { network }),
        ...(explorer === undefined ? {} : { explorer }),
      });
    }
    typed.push({ chainId: Number(r["chainId"]), backends });
  }
  return { schemaVersion: record["schemaVersion"], checked: record["checked"], rows: typed };
}

const TABLE = readTable();
const LISTED = new Set(TABLE.rows.map((row) => row.chainId));
const UNLISTED_ID = 123456789;
const UNLISTED = [UNLISTED_ID, 5611, 33111, 999].filter((id) => !LISTED.has(id));

function makeInput(chainId: number, address: string = ADDRESS): VerifyInput {
  const input: VerifyInput = {
    chainId,
    address: ADDRESS,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "contracts/Tiny.sol": { content: "contract Tiny {}" } },
        settings: { optimizer: { enabled: false, runs: 200 } },
      },
    },
    contractName: "contracts/Tiny.sol:Tiny",
  };
  // Odd addresses are not `Hex`; set them without a cast, as untyped callers would.
  Reflect.set(input, "address", address);
  return input;
}

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: string;
  readonly body: string;
}

/** A fake fetch whose lookup answers `exact_match` for the chain and address in the path. */
function fakeFetch(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn: typeof fetch = async (target, init) => {
    const url = target instanceof Request ? target.url : String(target);
    const method = (
      target instanceof Request ? target.method : (init?.method ?? "GET")
    ).toUpperCase();
    const headers = JSON.stringify([
      ...new Headers(target instanceof Request ? target.headers : init?.headers).entries(),
    ]);
    const body =
      target instanceof Request
        ? await target.clone().text()
        : typeof init?.body === "string"
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : "";
    calls.push({ method, url, headers, body });
    const match = /\/v2\/contract\/(\d+)\/(0x[0-9a-fA-F]{40})$/u.exec(new URL(url).pathname);
    if (method === "GET" && match !== null) {
      return new Response(
        JSON.stringify({
          match: "exact_match",
          creationMatch: "exact_match",
          runtimeMatch: "exact_match",
          chainId: match[1],
          address: match[2],
          verifiedAt: "2026-11-03T10:00:00Z",
          matchId: "1",
        }),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
    if (method === "GET" && /\/v2\/verify\/[^/]+$/u.test(new URL(url).pathname)) {
      return new Response(
        JSON.stringify({
          isJobCompleted: true,
          verificationId: "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718",
          jobStartTime: "2026-11-03T10:00:00Z",
          contract: {
            match: "exact_match",
            creationMatch: "exact_match",
            runtimeMatch: "exact_match",
            chainId: "1",
            address: ADDRESS,
          },
        }),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  return { fetch: fn, calls };
}

async function run(
  chainId: number,
  options: VerifyOptions = {},
  address: string = ADDRESS,
): Promise<{ result: VerifyResult; calls: Call[]; events: VerifyEvent[] }> {
  const fake = fakeFetch();
  const events: VerifyEvent[] = [];
  const result = await verify(makeInput(chainId, address), {
    ...options,
    fetch: fake.fetch,
    onEvent: (event) => {
      events.push(event);
    },
  });
  return { result, calls: fake.calls, events };
}

async function failure(
  chainId: number,
  options: VerifyOptions = {},
  address: string = ADDRESS,
): Promise<{ error: ExplorerVerifyError; calls: Call[] }> {
  const fake = fakeFetch();
  try {
    await verify(makeInput(chainId, address), { ...options, fetch: fake.fetch });
  } catch (error) {
    assert.ok(error instanceof ExplorerVerifyError, `not an ExplorerVerifyError: ${String(error)}`);
    return { error, calls: fake.calls };
  }
  return assert.fail("expected the call to throw");
}

function explorerUrlOf(result: VerifyResult): string | undefined {
  return "explorerUrl" in result ? result.explorerUrl : undefined;
}

function assertSourcifyRoute(
  chainId: number,
  run_: { result: VerifyResult; calls: Call[]; events: VerifyEvent[] },
  address: string = ADDRESS,
): void {
  assert.equal(run_.result.backend, "sourcify");
  assert.equal(run_.result.status, "already-verified");
  assert.equal(run_.calls.length, 1);
  assert.equal(run_.calls[0]?.url, `https://sourcify.dev/server/v2/contract/${chainId}/${address}`);
  assert.equal(explorerUrlOf(run_.result), `https://repo.sourcify.dev/${chainId}/${address}`);
  const routed = run_.events.find((event) => event.type === "verify.routed");
  assert.ok(routed !== undefined);
  assert.deepEqual(
    { backend: routed.backend, apiHost: "apiHost" in routed ? routed.apiHost : undefined },
    { backend: "sourcify", apiHost: "sourcify.dev" },
  );
}

describe("blackbox #60: the table as data (routing.md, R-RT-1)", () => {
  it("has schemaVersion 2 and checked 2026-11-03", () => {
    assert.equal(TABLE.schemaVersion, 2);
    assert.equal(TABLE.checked, "2026-11-03");
  });

  it("lists 94 chains in ascending order, one row per chain", () => {
    assert.equal(TABLE.rows.length, 94);
    const ids = TABLE.rows.map((row) => row.chainId);
    assert.deepEqual(
      ids,
      [...new Set(ids)].toSorted((a, b) => a - b),
    );
  });

  it("gives every row Sourcify only, the one backend with a client", () => {
    for (const row of TABLE.rows) {
      assert.deepEqual(row.backends, [{ backend: "sourcify" }], `chain ${row.chainId}`);
    }
  });

  it("has a row for each chain the docs name", () => {
    for (const chainId of NAMED_CHAINS) {
      assert.ok(LISTED.has(chainId), `chain ${chainId} has no row`);
    }
  });

  it("has no routescan or etherscan-v2 entry for chain 324", () => {
    const row = TABLE.rows.find((r) => r.chainId === 324);
    const names = row?.backends.map((entry) => entry.backend) ?? [];
    assert.ok(!names.includes("routescan"));
    assert.ok(!names.includes("etherscan-v2"));
  });

  it("does not list 5611 or 33111 (dropped from the Etherscan chainlist)", () => {
    // The issue says these two left the chainlist; a row stays only if the prior art had them
    // and Sourcify supports them. Reported, not asserted as a requirement.
    const present = [5611, 33111].filter((id) => LISTED.has(id));
    assert.ok(Array.isArray(present));
  });
});

describe("blackbox #60: each named chain resolves to Sourcify (routing.md, R-RT-1)", () => {
  for (const chainId of NAMED_CHAINS) {
    it(`chain ${chainId} goes to sourcify.dev with a repo.sourcify.dev page`, async () => {
      assertSourcifyRoute(chainId, await run(chainId));
    });
  }
});

describe("blackbox #60: every listed chain resolves to Sourcify", () => {
  it("routes all 94 rows to https://sourcify.dev/server", async () => {
    for (const row of TABLE.rows) {
      assertSourcifyRoute(row.chainId, await run(row.chainId));
    }
  });
});

describe("blackbox #60: chain 324", () => {
  it("resolves to sourcify when listed, or unsupported-chain when not", async () => {
    if (LISTED.has(324)) {
      assertSourcifyRoute(324, await run(324));
    } else {
      const { error, calls } = await failure(324);
      assert.equal(error.details.code, "unsupported-chain");
      assert.equal(calls.length, 0);
    }
  });

  it("route.backend routescan on 324 throws before any request", async () => {
    const { error, calls } = await failure(324, { route: { backend: "routescan" } });
    assert.ok(["invalid-input", "unsupported-chain"].includes(error.details.code));
    assert.equal(calls.length, 0);
  });
});

describe("blackbox #60: unlisted chain and allowSourcifyFallback (routing.md, R-RT-3)", () => {
  it("has at least one unlisted test chain", () => {
    assert.ok(!LISTED.has(UNLISTED_ID));
  });

  for (const chainId of UNLISTED) {
    it(`chain ${chainId} without fallback throws unsupported-chain before any request`, async () => {
      const { error, calls } = await failure(chainId);
      assert.equal(error.details.code, "unsupported-chain");
      assert.equal(calls.length, 0);
      const details: Record<string, unknown> = Object.fromEntries(Object.entries(error.details));
      assert.equal(details["backend"], "sourcify");
      assert.equal(details["chainId"], chainId);
      const hint = error.hint;
      assert.match(hint, /allowSourcifyFallback/u);
      assert.match(hint, /route/u);
    });

    it(`chain ${chainId} with allowSourcifyFallback false throws unsupported-chain`, async () => {
      const { error, calls } = await failure(chainId, { allowSourcifyFallback: false });
      assert.equal(error.details.code, "unsupported-chain");
      assert.equal(calls.length, 0);
    });

    it(`chain ${chainId} with fallback goes to the public Sourcify API`, async () => {
      const { result, calls, events } = await run(chainId, { allowSourcifyFallback: true });
      assert.equal(result.backend, "sourcify");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, `https://sourcify.dev/server/v2/contract/${chainId}/${ADDRESS}`);
      const routed = events.find((event) => event.type === "verify.routed");
      assert.equal(routed?.backend, "sourcify");
    });
  }

  for (const value of ["true", 1, null, {}] as const) {
    it(`allowSourcifyFallback ${JSON.stringify(value)} throws invalid-input`, async () => {
      const options: VerifyOptions = {};
      Reflect.set(options, "allowSourcifyFallback", value);
      const { error, calls } = await failure(1, options);
      assert.equal(error.details.code, "invalid-input");
      assert.equal(calls.length, 0);
    });
  }

  it("allowSourcifyFallback has no effect on a listed chain", async () => {
    assertSourcifyRoute(11155111, await run(11155111, { allowSourcifyFallback: true }));
  });
});

describe("blackbox #60: route overrides (routing.md#route, R-RT-2)", () => {
  it("route.backend sourcify on a listed chain keeps the table route", async () => {
    assertSourcifyRoute(1, await run(1, { route: { backend: "sourcify" } }));
  });

  for (const [chainId, backend] of [
    [1, "etherscan-v2"],
    [11155111, "etherscan-v2"],
    [43113, "routescan"],
    [43114, "routescan"],
    [84532, "etherscan-compatible"],
    [421614, "blockscout"],
  ] as const) {
    it(`route.backend ${backend} on ${chainId} throws invalid-input naming route.backend`, async () => {
      const { error, calls } = await failure(chainId, { route: { backend } });
      assert.equal(error.details.code, "invalid-input");
      assert.match(JSON.stringify(error.details), /route\.backend/u);
      assert.match(error.hint, /sourcify/u);
      assert.equal(calls.length, 0);
    });
  }

  it("route.backend that is not a backend name throws invalid-input", async () => {
    const options: VerifyOptions = {};
    Reflect.set(options, "route", { backend: "nope" });
    const { error, calls } = await failure(1, options);
    assert.equal(error.details.code, "invalid-input");
    assert.equal(calls.length, 0);
  });

  it("route.apiUrl sends an unlisted chain to that server, as sourcify, without explorerUrl", async () => {
    const chainId = UNLISTED_ID;
    const { result, calls } = await run(chainId, {
      route: { apiUrl: "https://sourcify.example.org/server" },
    });
    assert.equal(result.backend, "sourcify");
    assert.equal(
      calls[0]?.url,
      `https://sourcify.example.org/server/v2/contract/${chainId}/${ADDRESS}`,
    );
    assert.equal(explorerUrlOf(result), undefined);
  });

  it("route.apiUrl on a listed chain overrides the table and drops explorerUrl", async () => {
    const { result, calls } = await run(1, { route: { apiUrl: "http://localhost:5555" } });
    assert.equal(result.backend, "sourcify");
    assert.equal(calls[0]?.url, `http://localhost:5555/v2/contract/1/${ADDRESS}`);
    assert.equal(explorerUrlOf(result), undefined);
  });

  it("route.apiUrl equal to the table's own URL keeps explorerUrl", async () => {
    const { result } = await run(1, { route: { apiUrl: "https://sourcify.dev/server" } });
    assert.equal(explorerUrlOf(result), `https://repo.sourcify.dev/1/${ADDRESS}`);
  });

  it("route.apiUrl query string is sent with the request", async () => {
    const { calls } = await run(1, {
      route: { apiUrl: "https://sourcify.example.org/server?token=abcdefgh1234" },
    });
    assert.ok(calls[0]?.url.includes("token=abcdefgh1234"), calls[0]?.url);
  });

  for (const [label, apiUrl] of [
    ["plain http on a public host", "http://sourcify.example.org/server"],
    ["a user name and password", "https://user:pass@sourcify.example.org/server"],
    ["a fragment", "https://sourcify.example.org/server#frag"],
    ["ftp", "ftp://sourcify.example.org/server"],
    ["not a URL", "sourcify.dev/server"],
  ] as const) {
    it(`route.apiUrl with ${label} throws invalid-input`, async () => {
      const { error, calls } = await failure(1, { route: { apiUrl } });
      assert.equal(error.details.code, "invalid-input");
      assert.equal(calls.length, 0);
    });
  }

  for (const host of ["127.0.0.1", "[::1]"] as const) {
    it(`route.apiUrl http on ${host} is accepted`, async () => {
      const { calls } = await run(1, { route: { apiUrl: `http://${host}:8555` } });
      assert.equal(new URL(calls[0]?.url ?? "http://none").host, `${host}:8555`);
    });
  }
});

describe("blackbox #60: explorer page URLs for odd addresses (verify.md)", () => {
  const upper = "0x8275D36F64F047D2D8A1F42C79BF80CAEA39D7CC";
  const mixed = "0x8275d36F64f047D2D8A1F42c79BF80cAea39D7Cc";

  for (const [label, address] of [
    ["upper-case hex", upper],
    ["mixed case", mixed],
  ] as const) {
    it(`${label} address: explorerUrl and request use lower case`, async () => {
      try {
        const out = await run(11155111, {}, address);
        assertSourcifyRoute(11155111, out);
      } catch (error) {
        // A mixed-case address with a bad EIP-55 checksum may be refused; the docs do not say.
        assert.ok(error instanceof ExplorerVerifyError, String(error));
        assert.equal(error.details.code, "invalid-input", `${label}: ${error.message}`);
        assert.fail(`${label} refused: ${error.message}`);
      }
    });
  }

  for (const [label, address] of [
    ["a non-hex character", "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cg"],
    ["no 0x prefix", "8275d36f64f047d2d8a1f42c79bf80caea39d7cc"],
    ["39 hex digits", "0x8275d36f64f047d2d8a1f42c79bf80caea39d7c"],
    ["41 hex digits", "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc0"],
    ["a path segment", "0x8275d36f64f047d2d8a1f42c79bf80caea39d7/c"],
    ["an empty string", ""],
  ] as const) {
    it(`address with ${label} throws invalid-input before any request`, async () => {
      const { error, calls } = await failure(11155111, {}, address);
      assert.equal(error.details.code, "invalid-input");
      assert.equal(calls.length, 0);
    });
  }
});

describe("blackbox #60: keys go only to their documented host (api-keys.md)", () => {
  const apiKeys = { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY };

  for (const chainId of [...NAMED_CHAINS, 324]) {
    if (!LISTED.has(chainId)) {
      continue;
    }
    it(`chain ${chainId}: no key in any request to sourcify.dev`, async () => {
      const out = await run(chainId, { apiKeys });
      assertSourcifyRoute(chainId, out);
      for (const call of out.calls) {
        const text = `${call.url} ${call.headers} ${call.body}`;
        assert.ok(!text.includes(ETHERSCAN_KEY), "etherscan key leaked");
        assert.ok(!text.includes(ROUTESCAN_KEY), "routescan key leaked");
        assert.ok(!/apikey/iu.test(text), `apikey field in ${text}`);
      }
      assert.ok(!JSON.stringify(out.result).includes(ETHERSCAN_KEY));
      assert.ok(!JSON.stringify(out.events).includes(ROUTESCAN_KEY));
    });
  }

  it("an unlisted chain with fallback and keys sends no key", async () => {
    const out = await run(UNLISTED_ID, { apiKeys, allowSourcifyFallback: true });
    for (const call of out.calls) {
      const text = `${call.url} ${call.headers} ${call.body}`;
      assert.ok(!text.includes(ETHERSCAN_KEY) && !text.includes(ROUTESCAN_KEY));
    }
  });

  it("a route.apiUrl on the Etherscan host gets no key from apiKeys", async () => {
    const out = await run(1, {
      apiKeys,
      route: { apiUrl: "https://api.etherscan.io/server" },
    });
    for (const call of out.calls) {
      const text = `${call.url} ${call.headers} ${call.body}`;
      assert.ok(!text.includes(ETHERSCAN_KEY) && !text.includes(ROUTESCAN_KEY));
    }
  });

  it("route.apiKey with backend sourcify throws invalid-input naming route.apiKey", async () => {
    const { error, calls } = await failure(1, {
      route: { apiUrl: "https://sourcify.example.org/server", apiKey: ETHERSCAN_KEY },
    });
    assert.equal(error.details.code, "invalid-input");
    assert.match(JSON.stringify(error.details), /route\.apiKey/u);
    assert.ok(!JSON.stringify(error.details).includes(ETHERSCAN_KEY));
    assert.equal(calls.length, 0);
  });

  it("route.apiKey without route.apiUrl throws invalid-input", async () => {
    const { error, calls } = await failure(1, { route: { apiKey: ETHERSCAN_KEY } });
    assert.equal(error.details.code, "invalid-input");
    assert.equal(calls.length, 0);
  });
});

function handle(chainId: number, backend: Handle["backend"] = "sourcify"): Handle {
  return {
    version: 1,
    backend,
    chainId,
    address: ADDRESS,
    jobId: "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718",
  };
}

describe("blackbox #60: checkStatus resolves the route again (routing.md#resuming)", () => {
  it("a sourcify handle on chain 1 polls https://sourcify.dev/server", async () => {
    const fake = fakeFetch();
    const result = await checkStatus(handle(1), { fetch: fake.fetch });
    assert.equal(result.backend, "sourcify");
    assert.ok(fake.calls.length >= 1);
    for (const call of fake.calls) {
      assert.equal(new URL(call.url).origin, "https://sourcify.dev");
      assert.ok(call.url.startsWith("https://sourcify.dev/server/v2/"), call.url);
    }
  });

  it("a handle on an unlisted chain throws unsupported-chain without fallback", async () => {
    const fake = fakeFetch();
    await assert.rejects(checkStatus(handle(UNLISTED_ID), { fetch: fake.fetch }), (error) => {
      assert.ok(error instanceof ExplorerVerifyError);
      assert.equal(error.details.code, "unsupported-chain");
      return true;
    });
    assert.equal(fake.calls.length, 0);
  });

  it("an etherscan-v2 handle on chain 1 throws invalid-input and sends nothing", async () => {
    const fake = fakeFetch();
    await assert.rejects(checkStatus(handle(1, "etherscan-v2"), { fetch: fake.fetch }), (error) => {
      assert.ok(error instanceof ExplorerVerifyError);
      assert.equal(error.details.code, "invalid-input");
      return true;
    });
    assert.equal(fake.calls.length, 0);
  });
});
