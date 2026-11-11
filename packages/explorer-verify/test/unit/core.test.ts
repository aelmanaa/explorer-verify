// `explorer-verify/core`, `explorer-verify/clients/*` and `explorer-verify/table` (decision 0052,
// R-RUN-3, R-SEC-2, R-IN-6): the clients and the table a caller passes, and the errors for what it
// leaves out, all before any request.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { BACKEND_NAMES } from "../../src/backend-names.ts";
import { etherscan } from "../../src/backends/etherscan.ts";
import { sourcify as sourcifyBackend } from "../../src/backends/sourcify.ts";
import { blockscout, blockscoutHosted, blockscoutProxyLink } from "../../src/clients/blockscout.ts";
import * as blockscoutModule from "../../src/clients/blockscout.ts";
import {
  etherscanCompatible,
  etherscanCompatibleProxyLink,
} from "../../src/clients/etherscan-compatible.ts";
import * as compatibleModule from "../../src/clients/etherscan-compatible.ts";
import { etherscanV2, etherscanV2ProxyLink } from "../../src/clients/etherscan-v2.ts";
import * as etherscanV2Module from "../../src/clients/etherscan-v2.ts";
import { routescan } from "../../src/clients/routescan.ts";
import * as routescanModule from "../../src/clients/routescan.ts";
import { sourcify, sourcifyProxyLink } from "../../src/clients/sourcify.ts";
import * as sourcifyModule from "../../src/clients/sourcify.ts";
import { checkStatus, dryRun, linkProxy, verify, verifyEach } from "../../src/core/index.ts";
import type { CoreVerifyOptions, ExplorerClient, ProxyLinkClient } from "../../src/core/index.ts";
import * as coreEntry from "../../src/core/index.ts";
import { flowParts, linkOptions } from "../../src/core/options.ts";
import { clientParts, linkParts, tableRows } from "../../src/core/parts.ts";
import { routingTable } from "../../src/core/table.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import type { InputIssue } from "../../src/errors.ts";
import { runVerifyEach } from "../../src/flow/verify-each.ts";
import { runVerify, settingsOf, startBudget, withHandler } from "../../src/flow/verify.ts";
import type { HandlerCode } from "../../src/flow/verify.ts";
import { resolveHandler } from "../../src/http/handler-url.ts";
import * as mainEntry from "../../src/index.ts";
import { verify as mainVerify, routingTableDate } from "../../src/index.ts";
import { withDerivedArgs } from "../../src/input/constructor-args.ts";
import { ROUTING_TABLE } from "../../src/routing/table.ts";
import type { Hex, VerifyInput } from "../../src/types.ts";

const SEPOLIA = 11155111;
const FACTORY_OF = {
  "etherscan-v2": "etherscanV2ProxyLink",
  "etherscan-compatible": "etherscanCompatibleProxyLink",
  blockscout: "blockscoutProxyLink",
  "blockscout-hosted": "blockscoutProxyLink",
  sourcify: "sourcifyProxyLink",
} as const;
const GREETER: Hex = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const SOURCIFY_API = "https://sourcify.dev/server";
const HANDLER = "https://app.example/api/verify";
// A fake key. Never a real one (R-SEC-1).
const KEY = "DUMMYKEYcoretest0123456789ABCDEFGH";

const CLIENTS: readonly [ExplorerClient, ...ExplorerClient[]] = [
  sourcify(),
  etherscanV2(),
  etherscanCompatible(),
  routescan(),
  blockscout(),
  blockscoutHosted(),
];
const LINKS: readonly [ProxyLinkClient, ...ProxyLinkClient[]] = [
  sourcifyProxyLink(),
  etherscanV2ProxyLink(),
  etherscanCompatibleProxyLink(),
  blockscoutProxyLink(),
];

function input(chainId = SEPOLIA): VerifyInput {
  return {
    chainId,
    address: GREETER,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "contracts/Greeter.sol": { content: "contract Greeter {}" } },
        settings: {},
      },
    },
    contractName: "contracts/Greeter.sol:Greeter",
  };
}

/** The response `test/fixtures/<backend>/<name>.json` recorded. */
function recorded(backend: string, name: string): Response {
  const url = new URL(`../fixtures/${backend}/${name}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  const response: unknown = Reflect.get(Object(parsed), "response");
  const status: unknown = Reflect.get(Object(response), "status");
  assert.ok(typeof status === "number");
  return new Response(JSON.stringify(Reflect.get(Object(response), "body")), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that records each URL and gives `answer` to every request. */
function answering(answer: () => Response): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (request) => {
      urls.push(String(request instanceof Request ? request.url : request));
      return await Promise.resolve(answer());
    },
  };
}

/** A fetch that records each URL and answers Sourcify's "exact match" lookup. */
function sourcifyFetch(): { fetch: typeof fetch; urls: string[] } {
  return answering(() => recorded("sourcify", "2026-11-02-lookup-exact-match"));
}

/** A fetch that fails the test on any request. */
const noRequest: typeof fetch = async () => {
  await Promise.resolve();
  throw new Error("no request was expected");
};

/** The error a call rejects with, which must be an ExplorerVerifyError. */
async function errorOf(call: unknown): Promise<ExplorerVerifyError> {
  const outcome: unknown = await Promise.resolve(call).then(
    () => "resolved",
    (error: unknown) => error,
  );
  assert.ok(outcome instanceof ExplorerVerifyError, String(outcome));
  return outcome;
}

/** A handlerUrl code loader that never settles. */
const never = async (): Promise<HandlerCode> => await new Promise<HandlerCode>(() => {});

/** Calls `run` with arguments typed as `unknown`, as a JavaScript caller would pass them. */
function untyped(run: (...args: never[]) => unknown, ...args: unknown[]): unknown {
  const result: unknown = Reflect.apply(run, undefined, args);
  return result;
}

/** The issues of an `invalid-input`. */
function issuesOf(error: ExplorerVerifyError): readonly InputIssue[] {
  assert.equal(error.details.code, "invalid-input");
  return error.details.code === "invalid-input" ? error.details.issues : [];
}

describe("the clients and the table (decision 0052)", () => {
  it("each client names its backend and kind, is frozen, and holds its backend's code", () => {
    assert.deepEqual(
      CLIENTS.map((client) => [client.kind, client.backend]),
      [
        ["client", "sourcify"],
        ["client", "etherscan-v2"],
        ["client", "etherscan-compatible"],
        ["client", "routescan"],
        ["client", "blockscout"],
        ["client", "blockscout-hosted"],
      ],
    );
    for (const client of CLIENTS) {
      assert.ok(Object.isFrozen(client));
      assert.equal(clientParts(client)?.backend.name, client.backend);
    }
    assert.equal(clientParts(sourcify())?.backend, sourcifyBackend);
    assert.equal(clientParts(etherscanV2())?.backend, etherscan);
  });

  it("every client that takes constructor arguments brings the derivation; only Etherscan v2 brings the handlerUrl code", async () => {
    for (const client of CLIENTS) {
      const parts = clientParts(client);
      assert.ok(parts !== undefined);
      assert.equal(
        parts.derivation !== undefined,
        parts.backend.takesConstructorArgs === true,
        client.backend,
      );
      assert.equal(parts.handler !== undefined, client.backend === "etherscan-v2", client.backend);
    }
    // The loaders give the code they imported statically.
    assert.equal(await clientParts(etherscanV2())?.derivation?.(), withDerivedArgs);
    assert.equal((await clientParts(etherscanV2())?.handler?.())?.resolveHandler, resolveHandler);
  });

  it("each proxy-link client names its backends, and together they cover every backend but Routescan", () => {
    assert.deepEqual(
      LINKS.map((client) => [client.kind, ...client.backends]),
      [
        ["proxy-link", "sourcify"],
        ["proxy-link", "etherscan-v2"],
        ["proxy-link", "etherscan-compatible"],
        ["proxy-link", "blockscout", "blockscout-hosted"],
      ],
    );
    for (const client of LINKS) {
      assert.ok(Object.isFrozen(client) && Object.isFrozen(client.backends));
      assert.deepEqual(linkParts(client)?.backends, client.backends);
    }
    assert.equal(linkParts(etherscanV2ProxyLink())?.handler !== undefined, true);
    assert.equal(linkParts(sourcifyProxyLink())?.handler, undefined);
    const linked = LINKS.flatMap((client) => client.backends);
    assert.deepEqual(
      BACKEND_NAMES.filter((name) => !linked.includes(name)),
      ["routescan"],
    );
  });

  it("the table holds the shipped rows and their date", async () => {
    assert.equal(routingTable.kind, "routing-table");
    assert.equal(routingTable.date, ROUTING_TABLE.checked);
    assert.equal(routingTable.date, await routingTableDate());
    assert.ok(Object.isFrozen(routingTable));
    assert.equal(tableRows(routingTable), ROUTING_TABLE);
  });

  it("an object built by hand holds nothing", () => {
    for (const value of [{ kind: "client", backend: "sourcify" }, null, "sourcify", 1, undefined]) {
      assert.equal(clientParts(value), undefined);
      assert.equal(linkParts(value), undefined);
      assert.equal(tableRows(value), undefined);
    }
    assert.equal(clientParts(sourcifyProxyLink()), undefined);
    assert.equal(linkParts(sourcify()), undefined);
    assert.equal(tableRows(sourcify()), undefined);
  });
});

describe("explorer-verify/core reads clients and table (R-IN-6, decision 0052)", () => {
  const route = { backend: "sourcify", apiUrl: SOURCIFY_API } as const;

  it("refuses options that are not a plain object, or hold no clients", async () => {
    const cases: [options: unknown, field: string, message: string][] = [
      [undefined, "options", "must be a plain object"],
      ["sourcify", "options", "must be a plain object"],
      [[sourcify()], "options", "must be a plain object"],
      [null, "options", "must be a plain object"],
      [{}, "clients", "is required: an array of clients, such as [sourcify()]"],
      [{ clients: undefined }, "clients", "is required: an array of clients, such as [sourcify()]"],
      [{ clients: [] }, "clients", "must be a non-empty array of clients, such as [sourcify()]"],
      [
        { clients: sourcify() },
        "clients",
        "must be a non-empty array of clients, such as [sourcify()]",
      ],
    ];
    for (const [options, field, message] of cases) {
      const error = await errorOf(untyped(verify, input(), options));
      assert.deepEqual(issuesOf(error), [{ field, message }], JSON.stringify(options));
      assert.equal(error.message, `The options are invalid: ${field}.`);
      assert.match(error.hint, /explorer-verify\/clients, such as \[sourcify\(\)\]/);
    }
  });

  it("names each entry of clients that this package did not export, and a client of the other kind", async () => {
    const forged = { kind: "client", backend: "sourcify" };
    const error = await errorOf(
      untyped(verify, input(), {
        clients: [sourcify(), forged, sourcifyProxyLink()],
        table: { date: "2026-11-05" },
      }),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "clients[1]", message: "must be a client from explorer-verify/clients" },
      { field: "clients[2]", message: "is a proxy-link client: pass it to linkProxy()" },
      { field: "table", message: "must be routingTable from explorer-verify/table" },
    ]);
    assert.equal(error.message, "The options are invalid: clients[1], clients[2], table.");
    const link = await errorOf(
      untyped(linkProxy, { chainId: SEPOLIA, address: GREETER }, { clients: [sourcify(), forged] }),
    );
    assert.deepEqual(issuesOf(link), [
      {
        field: "clients[0]",
        message: "is not a proxy-link client: pass one such as sourcifyProxyLink()",
      },
      { field: "clients[1]", message: "must be a proxy-link client from explorer-verify/clients" },
    ]);
  });

  it("names a routing table of another copy of the package, and gives linkProxy a proxy-link hint", async () => {
    const otherTable = Object.freeze({ kind: "routing-table", date: routingTable.date });
    const error = await errorOf(
      untyped(verify, input(), { clients: [sourcify()], table: otherTable }),
    );
    assert.deepEqual(issuesOf(error), [
      {
        field: "table",
        message:
          "is a routing table from another copy of explorer-verify: install explorer-verify once, as a peerDependency of your wrapper",
      },
    ]);
    const plain = await errorOf(untyped(verify, input(), { clients: [sourcify()], table: {} }));
    assert.equal(issuesOf(plain)[0]?.message, "must be routingTable from explorer-verify/table");
    const link = await errorOf(
      untyped(linkProxy, { chainId: SEPOLIA, address: GREETER }, { clients: [] }),
    );
    assert.match(link.hint, /such as \[sourcifyProxyLink\(\)\]/);
    const notObject = await errorOf(untyped(linkProxy, { chainId: SEPOLIA, address: GREETER }, []));
    assert.deepEqual(issuesOf(notObject), [
      { field: "options", message: "must be a plain object" },
    ]);
    assert.match(notObject.hint, /such as \[sourcifyProxyLink\(\)\]/);
  });

  it("names a frozen client of another copy of the package, a hole, and unknown keys together", async () => {
    const otherCopy = Object.freeze({ kind: "client", backend: "sourcify" });
    const otherLink = Object.freeze({ kind: "proxy-link", backends: ["sourcify"] });
    // A sparse array: index 1 is a hole.
    const sparse: unknown[] = [sourcify()];
    sparse[2] = otherCopy;
    const error = await errorOf(untyped(verify, input(), { clients: sparse, foo: 1 }));
    assert.deepEqual(
      issuesOf(error).map((issue) => issue.field),
      ["foo", "clients[1]", "clients[2]"],
    );
    assert.equal(issuesOf(error)[1]?.message, "must be a client from explorer-verify/clients");
    assert.equal(
      issuesOf(error)[2]?.message,
      "is a client from another copy of explorer-verify: install explorer-verify once, as a peerDependency of your wrapper",
    );
    const link = await errorOf(
      untyped(linkProxy, { chainId: SEPOLIA, address: GREETER }, { clients: [otherLink] }),
    );
    assert.match(issuesOf(link)[0]?.message ?? "", /another copy of explorer-verify/);
    const each = await errorOf(
      untyped(verifyEach, input(), { clients: [], backends: "all", timeout: 1 }),
    );
    assert.deepEqual(
      issuesOf(each).map((issue) => issue.field),
      ["timeout", "clients"],
    );
  });

  it("gives invalid-input, without the getter's text, when a getter or Proxy trap throws", async () => {
    const throwing = new Proxy<CoreVerifyOptions>(
      { clients: [sourcify()] },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error(`trap ${KEY}`);
        },
      },
    );
    const error = await errorOf(verify(input(), throwing));
    assert.deepEqual(issuesOf(error), [{ field: "options", message: "could not be read" }]);
    assert.doesNotMatch(JSON.stringify(error.toJSON()), new RegExp(KEY));
  });

  it("hands the other options to the engine unread: an unknown key throws, and its getter never runs", async () => {
    const reads: string[] = [];
    const options = (): { route: typeof route; fetch: typeof fetch; readonly timeout: number } => ({
      route,
      fetch: noRequest,
      get timeout(): number {
        reads.push("timeout");
        return 5;
      },
    });
    const error = await errorOf(
      verify(
        input(),
        Object.defineProperties(
          { clients: [sourcify()] },
          Object.getOwnPropertyDescriptors(options()),
        ),
      ),
    );
    const fromMain = await errorOf(mainVerify(input(), options()));
    assert.equal(issuesOf(error)[0]?.field, "timeout");
    assert.deepEqual(issuesOf(error), issuesOf(fromMain));
    assert.equal(error.message, fromMain.message);
    assert.deepEqual(reads, []);
  });

  it("reads clients and table through getters once, and passes the getters of other options to the engine", async () => {
    const reads: string[] = [];
    const answer = sourcifyFetch();
    const result = await verify(input(), {
      get clients(): readonly [ExplorerClient, ...ExplorerClient[]] {
        reads.push("clients");
        return [sourcify()];
      },
      get table(): undefined {
        reads.push("table");
        return undefined;
      },
      get fetch(): typeof fetch {
        reads.push("fetch");
        return answer.fetch;
      },
      route,
    });
    assert.equal(result.status, "already-verified");
    assert.deepEqual(reads, ["clients", "table", "fetch"]);
  });
});

describe("a backend without a client in clients (decision 0052, R-SEC-2)", () => {
  it("route.backend naming it throws invalid-input before any request", async () => {
    const error = await errorOf(
      verify(input(), {
        clients: [sourcify()],
        table: routingTable,
        fetch: noRequest,
        route: { backend: "blockscout" },
      }),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "route.backend", message: "has no client in clients" },
    ]);
    assert.equal(error.hint, "Add blockscout() to clients, or leave out route.backend.");
  });

  it("a chain whose listed backends have no client throws unsupported-chain naming them all, in verify() and verifyEach()", async () => {
    // No backend Sepolia's row lists has a client among those passed.
    const error = await errorOf(
      verify(input(), {
        clients: [etherscanCompatible()],
        table: routingTable,
        fetch: noRequest,
      }),
    );
    assert.equal(error.code, "unsupported-chain");
    assert.equal(
      error.message,
      "No client in clients serves chain 11155111, which the routing table routes to etherscan-v2, sourcify, blockscout, routescan.",
    );
    assert.match(error.hint, /^Add one of their clients to clients, such as \w+\(\)\.$/);
    const each = await errorOf(
      verifyEach(input(), {
        clients: [etherscanCompatible()],
        table: routingTable,
        fetch: noRequest,
        backends: "all",
      }),
    );
    assert.equal(each.code, "unsupported-chain");
    assert.equal(each.message, error.message);
  });

  it("the table chooses among the clients passed", async () => {
    const answer = sourcifyFetch();
    const result = await dryRun(input(), {
      clients: [sourcify()],
      table: routingTable,
      fetch: answer.fetch,
      apiKeys: { "etherscan-v2": KEY },
    });
    // With a key, Sepolia's row picks etherscan-v2 first; without its client, Sourcify.
    assert.equal(result.backend, "sourcify");
    assert.ok(answer.urls.every((url) => url.startsWith(`${SOURCIFY_API}/`)));
  });

  it("linkProxy() names clients for a backend whose proxy-link client was not passed", async () => {
    const target = { chainId: SEPOLIA, address: GREETER };
    const named = await errorOf(
      linkProxy(target, {
        clients: [sourcifyProxyLink()],
        table: routingTable,
        fetch: noRequest,
        route: { backend: "blockscout" },
      }),
    );
    assert.deepEqual(issuesOf(named), [
      { field: "clients", message: "has no blockscout proxy-link client" },
    ]);
    assert.equal(named.message, "No blockscout proxy-link client was passed in clients.");
    const chosen = await errorOf(
      linkProxy(target, {
        clients: [blockscoutProxyLink()],
        table: routingTable,
        fetch: noRequest,
        apiKeys: { "etherscan-v2": KEY },
      }),
    );
    assert.deepEqual(issuesOf(chosen), [
      { field: "clients", message: "has no etherscan-v2 proxy-link client" },
    ]);
    // Routescan links nowhere: the default entry's error.
    const routescanLink = await errorOf(
      linkProxy(target, { clients: LINKS, fetch: noRequest, route: { backend: "routescan" } }),
    );
    assert.deepEqual(issuesOf(routescanLink), [
      { field: "route.backend", message: "routescan cannot link a proxy" },
    ]);
  });
});

describe("explorer-verify/core without table (decision 0052, R-SEC-2)", () => {
  it("a call without route.apiUrl throws invalid-input naming table, before any request", async () => {
    const calls: [string, () => Promise<unknown>][] = [
      ["verify", async () => await verify(input(), { clients: CLIENTS, fetch: noRequest })],
      ["dryRun", async () => await dryRun(input(), { clients: CLIENTS, fetch: noRequest })],
      [
        "checkStatus",
        async () =>
          await checkStatus(`ev1:blockscout:${String(SEPOLIA)}:${GREETER}:abc`, {
            clients: CLIENTS,
            fetch: noRequest,
          }),
      ],
      [
        "verifyEach",
        async () =>
          await verifyEach(input(), {
            clients: CLIENTS,
            fetch: noRequest,
            // The first entry reads the table only for its explorer page: without a table it
            // reads none. The second needs the table to route.
            backends: [
              {
                backend: "etherscan-v2",
                apiUrl: "https://api.etherscan.io/v2/api",
                apiKey: KEY,
              },
              "blockscout",
            ],
          }),
      ],
      [
        "verifyEach all",
        async () =>
          await verifyEach(input(), { clients: CLIENTS, fetch: noRequest, backends: "all" }),
      ],
      [
        "linkProxy",
        async () =>
          await linkProxy(
            { chainId: SEPOLIA, address: GREETER },
            { clients: LINKS, fetch: noRequest },
          ),
      ],
    ];
    for (const [name, call] of calls) {
      const error = await errorOf(call());
      assert.deepEqual(
        issuesOf(error),
        [{ field: "table", message: "is needed: the route reads the routing table" }],
        name,
      );
      assert.equal(error.hint, "Add table from explorer-verify/table, or set route.apiUrl.");
    }
  });

  it("a backend with one public host for every chain needs no table and no apiUrl", async () => {
    const sourcifyAnswer = sourcifyFetch();
    const fromSourcify = await verify(input(), {
      clients: [sourcify()],
      fetch: sourcifyAnswer.fetch,
      route: { backend: "sourcify" },
    });
    assert.equal(fromSourcify.status, "already-verified");
    assert.ok(sourcifyAnswer.urls.every((url) => url.startsWith(`${SOURCIFY_API}/`)));
    // Sourcify's page needs no row.
    assert.equal(
      fromSourcify.explorerUrl,
      `https://repo.sourcify.dev/${String(SEPOLIA)}/${GREETER}`,
    );
    const etherscanAnswer = answering(() =>
      recorded("etherscan", "2026-11-04-getsourcecode-sepolia-greeter"),
    );
    const fromEtherscan = await verify(input(), {
      clients: [etherscanV2()],
      fetch: etherscanAnswer.fetch,
      apiKeys: { "etherscan-v2": KEY },
      route: { backend: "etherscan-v2" },
    });
    assert.equal(fromEtherscan.status, "already-verified");
    // Etherscan's page host comes from a row: without the table there is none.
    assert.equal("explorerUrl" in fromEtherscan, false);
    assert.ok(
      etherscanAnswer.urls.every((url) => url.startsWith("https://api.etherscan.io/v2/api?")),
    );
    const plan = await dryRun(input(), {
      clients: [etherscanV2()],
      fetch: noRequest,
      route: { backend: "etherscan-v2" },
    });
    // No key: the dry run skips the lookup, and names Etherscan's host.
    assert.equal(plan.apiHost, "api.etherscan.io");
    assert.equal(plan.lookup, "skipped");
    // A backend whose host depends on the chain still needs the table or apiUrl.
    const error = await errorOf(
      verify(input(), {
        clients: [routescan()],
        fetch: noRequest,
        route: { backend: "routescan" },
      }),
    );
    assert.equal(issuesOf(error)[0]?.field, "table");
  });

  it("checkStatus() without a table or a route takes a fixed host from the handle's backend", async () => {
    const answer = answering(() => recorded("sourcify", "2026-11-02-job-exact-match"));
    const result = await checkStatus(
      `ev1:sourcify:${String(SEPOLIA)}:${GREETER}:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718`,
      { clients: [sourcify()], fetch: answer.fetch },
    );
    assert.equal(result.status, "verified");
    assert.ok(
      answer.urls.length > 0 && answer.urls.every((url) => url.startsWith(`${SOURCIFY_API}/`)),
    );
    // A route the caller set is kept: here one that needs the table.
    const error = await errorOf(
      checkStatus(
        `ev1:sourcify:${String(SEPOLIA)}:${GREETER}:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718`,
        {
          clients: [sourcify()],
          fetch: noRequest,
          route: {},
        },
      ),
    );
    assert.equal(issuesOf(error)[0]?.field, "table");
    // A handle of a backend whose host depends on the chain still needs the table.
    const blockscoutHandle = await errorOf(
      checkStatus(`ev1:blockscout:${String(SEPOLIA)}:${GREETER}:abc`, {
        clients: [blockscout()],
        fetch: noRequest,
      }),
    );
    assert.equal(issuesOf(blockscoutHandle)[0]?.field, "table");
    // With a table, the table routes as before.
    const withTable = await errorOf(
      checkStatus(`ev1:etherscan-v2:${String(SEPOLIA)}:${GREETER}:abc`, {
        clients: [etherscanV2()],
        table: routingTable,
        fetch: noRequest,
      }),
    );
    assert.equal(withTable.code, "missing-api-key");
  });

  it("checkStatus() names a handle's backend that has no client in clients, before any route", async () => {
    const handle = `ev1:etherscan-v2:${String(SEPOLIA)}:${GREETER}:abc123`;
    const error = await errorOf(
      checkStatus(handle, { clients: [sourcify()], table: routingTable, fetch: noRequest }),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "clients", message: "has no etherscan-v2 client, the backend the handle names" },
    ]);
    assert.equal(error.hint, "Add etherscanV2() to clients.");
  });

  it("a call with route.apiUrl reaches only the caller's host, and reads no row", async () => {
    const answer = sourcifyFetch();
    const result = await verify(input(), {
      clients: [sourcify()],
      fetch: answer.fetch,
      route: { backend: "sourcify", apiUrl: "https://sourcify.example.org/server" },
    });
    assert.equal(result.status, "already-verified");
    assert.ok(answer.urls.length > 0);
    assert.ok(answer.urls.every((url) => url.startsWith("https://sourcify.example.org/server/")));
  });

  it("Etherscan's own API URL without a table goes there with no explorer page", async () => {
    const answer = answering(() =>
      recorded("etherscan", "2026-11-04-getsourcecode-sepolia-greeter"),
    );
    const result = await verify(input(), {
      clients: [etherscanV2()],
      route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api", apiKey: KEY },
      fetch: answer.fetch,
    });
    assert.equal(result.status, "already-verified");
    assert.equal("explorerUrl" in result, false);
    assert.ok(answer.urls.length > 0);
    assert.ok(answer.urls.every((url) => url.startsWith("https://api.etherscan.io/v2/api")));
  });
});

describe("handlerUrl through explorer-verify/core (decisions 0046 and 0052)", () => {
  it("needs the Etherscan v2 client, which brings the handler code", async () => {
    const error = await errorOf(
      verify(input(), {
        clients: [sourcify()],
        table: routingTable,
        handlerUrl: HANDLER,
        fetch: noRequest,
      }),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "handlerUrl", message: "needs the etherscanV2() client in clients" },
    ]);
    assert.equal(error.hint, "Add etherscanV2() to clients, or leave out handlerUrl.");
    const link = await errorOf(
      linkProxy(
        { chainId: SEPOLIA, address: GREETER },
        {
          clients: [sourcifyProxyLink()],
          table: routingTable,
          handlerUrl: HANDLER,
          fetch: noRequest,
        },
      ),
    );
    assert.deepEqual(issuesOf(link), [
      { field: "handlerUrl", message: "needs the etherscanV2ProxyLink() client in clients" },
    ]);
    assert.equal(link.hint, "Add etherscanV2ProxyLink() to clients, or leave out handlerUrl.");
  });

  it("with the Etherscan v2 client, routes Etherscan requests to the handler", async () => {
    const answer = answering(() =>
      recorded("etherscan", "2026-11-04-getsourcecode-sepolia-greeter"),
    );
    const result = await dryRun(input(), {
      clients: [etherscanV2(), sourcify()],
      table: routingTable,
      handlerUrl: HANDLER,
      fetch: answer.fetch,
      route: { backend: "etherscan-v2" },
    });
    assert.equal(result.backend, "etherscan-v2");
    assert.equal(result.apiHost, "app.example");
    assert.ok(answer.urls.length > 0);
    assert.ok(answer.urls.every((url) => url.startsWith(`${HANDLER}?`)));
    // A handler URL that fails its check throws, as in the default entry.
    const bad = await errorOf(
      dryRun(input(), {
        clients: [etherscanV2()],
        table: routingTable,
        handlerUrl: "ftp://app.example/verify",
        fetch: noRequest,
      }),
    );
    assert.equal(issuesOf(bad)[0]?.field, "handlerUrl");
  });
});

describe("more of what explorer-verify/core reads (decision 0052)", () => {
  it("names clients for each backend that can link, with the hint, and redacts the keys", async () => {
    for (const backend of [
      "etherscan-v2",
      "etherscan-compatible",
      "blockscout",
      "blockscout-hosted",
      "sourcify",
    ] as const) {
      const other = backend === "sourcify" ? blockscoutProxyLink() : sourcifyProxyLink();
      const error = await errorOf(
        linkProxy(
          { chainId: SEPOLIA, address: GREETER },
          {
            clients: [other],
            fetch: noRequest,
            route: { backend },
            apiKeys: { "etherscan-v2": KEY },
          },
        ),
      );
      assert.deepEqual(issuesOf(error), [
        { field: "clients", message: `has no ${backend} proxy-link client` },
      ]);
      assert.equal(
        error.hint,
        `Add ${FACTORY_OF[backend]}() to clients, or set route.backend to another backend.`,
      );
      assert.doesNotMatch(JSON.stringify(error.toJSON()), new RegExp(KEY));
    }
  });

  it("refuses a standalone entry the table chose, as the default entry does, when its client was passed", async () => {
    // Bitlayer's row lists only a standalone Etherscan-compatible explorer (decision 0039).
    const error = await errorOf(
      linkProxy(
        { chainId: 200_901, address: GREETER },
        { clients: [etherscanCompatibleProxyLink()], table: routingTable, fetch: noRequest },
      ),
    );
    assert.deepEqual(issuesOf(error), [
      { field: "route.backend", message: "etherscan-compatible cannot link a proxy" },
    ]);
  });

  it("takes the derivation and the handlerUrl code from whichever client brings them", () => {
    const flow = flowParts({ clients: [sourcify(), etherscanV2()] }, []).dependencies;
    assert.equal(flow.derivation, clientParts(etherscanV2())?.derivation);
    assert.equal(flow.handler, clientParts(etherscanV2())?.handler);
    const link = linkOptions(
      { clients: [sourcifyProxyLink(), etherscanV2ProxyLink()] },
      [],
    ).dependencies;
    assert.equal(link.handler, linkParts(etherscanV2ProxyLink())?.handler);
  });

  it("verifyEach() with the table reads the row for an entry at Etherscan's own API URL", async () => {
    const answer = answering(() =>
      recorded("etherscan", "2026-11-04-getsourcecode-sepolia-greeter"),
    );
    const { outcomes } = await verifyEach(input(), {
      clients: [etherscanV2()],
      table: routingTable,
      fetch: answer.fetch,
      backends: [
        { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api", apiKey: KEY },
      ],
    });
    const [outcome] = outcomes;
    assert.ok(outcome?.ok === true);
    assert.equal(
      outcome.result.explorerUrl,
      `https://sepolia.etherscan.io/address/${GREETER}#code`,
    );
  });
});

describe("the shape of explorer-verify/core (decision 0052)", () => {
  it("has a counterpart for every flow function of the default entry", () => {
    const flows = ["verify", "dryRun", "checkStatus", "verifyEach", "linkProxy"];
    for (const name of Object.keys(mainEntry)) {
      if (flows.includes(name)) {
        assert.equal(typeof Reflect.get(coreEntry, name), "function", name);
      }
    }
    assert.deepEqual(Object.keys(coreEntry).toSorted(), flows.toSorted());
  });

  it("each client module exports factories that give a new frozen client per call", () => {
    const modules = [
      blockscoutModule,
      compatibleModule,
      etherscanV2Module,
      routescanModule,
      sourcifyModule,
    ];
    // Every client module of src/clients but the two helper modules is listed.
    assert.equal(modules.length, readdirSync(path.join(SRC, "clients")).length - 2);
    for (const module of modules) {
      for (const [name, factory] of Object.entries(module)) {
        const first = factory();
        const second = factory();
        assert.ok(Object.isFrozen(first) && first !== second, name);
        assert.ok(clientParts(first) !== undefined || linkParts(first) !== undefined, name);
      }
    }
  });

  it("every top-level call in the client modules and the table module is marked pure", () => {
    const files = [
      ...readdirSync(path.join(SRC, "clients")).map((name) => path.join(SRC, "clients", name)),
      path.join(SRC, "core/table.ts"),
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // Stryker's instrumented copy of a mutated file holds every mutant at once: skip it.
      if (text.includes("stryMutAct_")) {
        continue;
      }
      for (const line of text.split("\n")) {
        if (/^export const \w+(?::[^=]+)? = \w+\(/.test(line)) {
          assert.fail(`${file}: ${line} needs /* @__PURE__ */`);
        }
      }
    }
  });

  it("the default entry hints at explorer-verify/core for clients and table", async () => {
    const error = await errorOf(
      untyped(mainVerify, input(), { clients: [sourcify()], table: routingTable }),
    );
    assert.deepEqual(
      issuesOf(error).map((issue) => issue.field),
      ["clients", "table"],
    );
    assert.match(error.hint, / Use explorer-verify\/core for clients and table\.$/);
    const other = await errorOf(untyped(mainVerify, input(), { timeout: 1 }));
    assert.doesNotMatch(other.hint, /explorer-verify\/core/);
  });
});

describe("the hints and names of explorer-verify/core (decision 0052)", () => {
  it("names the factory to add for each backend in route.backend", async () => {
    const factories = {
      sourcify: "sourcify",
      "etherscan-v2": "etherscanV2",
      "etherscan-compatible": "etherscanCompatible",
      routescan: "routescan",
      blockscout: "blockscout",
      "blockscout-hosted": "blockscoutHosted",
    } as const;
    for (const [backend, factory] of Object.entries(factories)) {
      const clients: readonly [ExplorerClient] =
        backend === "blockscout" ? [routescan()] : [blockscout()];
      const error = await errorOf(
        untyped(verify, input(), {
          clients,
          table: routingTable,
          fetch: noRequest,
          route: { backend },
        }),
      );
      assert.equal(error.hint, `Add ${factory}() to clients, or leave out route.backend.`, backend);
    }
    // An unknown name gets the default entry's hint, which lists the clients passed.
    const unknown = await errorOf(
      untyped(verify, input(), {
        clients: [sourcify()],
        fetch: noRequest,
        route: { backend: "nope" },
      }),
    );
    assert.equal(unknown.hint, "Leave out route.backend, or name one of: sourcify.");
  });

  it("names the backends of the chain asked for, not of another row", async () => {
    // Bitlayer's row lists only a standalone Etherscan-compatible explorer.
    const error = await errorOf(
      verify(
        { ...input(), chainId: 200_901 },
        { clients: [sourcify()], table: routingTable, fetch: noRequest },
      ),
    );
    assert.equal(
      error.message,
      "No client in clients serves chain 200901, which the routing table routes to etherscan-compatible.",
    );
    assert.equal(error.hint, "Add one of their clients to clients, such as etherscanCompatible().");
  });

  it("names a null entry, and an unknown key that may be a secret by the options", async () => {
    const error = await errorOf(
      untyped(verify, input(), {
        clients: [sourcify(), null],
        "0x1234567890123456789012345678901234567890": 1,
      }),
    );
    assert.deepEqual(
      issuesOf(error).map((issue) => issue.field),
      ["options", "clients[1]"],
    );
  });

  it("serves a route with apiUrl, and Blockscout's hosted API, without a table", async () => {
    const answer = answering(() => recorded("blockscout", "2026-11-04-lookup-sepolia-greeter"));
    const plan = await dryRun(input(), {
      clients: [blockscout()],
      fetch: answer.fetch,
      route: { backend: "blockscout", apiUrl: "https://eth-sepolia.blockscout.com/api" },
    });
    assert.equal(plan.backend, "blockscout");
    assert.equal(plan.apiHost, "eth-sepolia.blockscout.com");
    const hosted = await dryRun(input(), {
      clients: [blockscoutHosted()],
      fetch: noRequest,
      route: { backend: "blockscout-hosted" },
    });
    assert.equal(hosted.apiHost, "api.blockscout.com");
    assert.equal(hosted.lookup, "skipped");
  });

  it("the default entry's hint names explorer-verify/core for clients or table alone, and only then", async () => {
    const base =
      "Pass options as a plain object: timeoutMs, pollIntervalMs and indexWaitMs as positive numbers of milliseconds, signal as an AbortSignal, fetch and onEvent as functions, logger as an object, apiKeys as an object of key strings by backend name. Leave out any you do not need.";
    const clientsOnly = await errorOf(untyped(mainVerify, input(), { clients: [sourcify()] }));
    assert.equal(clientsOnly.hint, `${base} Use explorer-verify/core for clients and table.`);
    const tableOnly = await errorOf(
      untyped(mainVerify, input(), { timeout: 1, table: routingTable }),
    );
    assert.equal(tableOnly.hint, `${base} Use explorer-verify/core for clients and table.`);
    const other = await errorOf(untyped(mainVerify, input(), { timeout: 1 }));
    assert.equal(other.hint, base);
  });
});

describe("the engine without a part (decision 0052)", () => {
  it("verifyEach() loads no table for entries whose apiUrl reads none", async () => {
    let loads = 0;
    const result = await runVerifyEach(
      input(),
      { fetch: sourcifyFetch().fetch, backends: [{ backend: "sourcify", apiUrl: SOURCIFY_API }] },
      {
        backends: { sourcify: sourcifyBackend },
        table: async () => {
          loads += 1;
          return await Promise.resolve(ROUTING_TABLE);
        },
      },
    );
    assert.equal(result.outcomes[0]?.ok, true);
    assert.equal(loads, 0);
  });

  it("bounds the handlerUrl code's load by the budget, naming it and etherscan-v2", async () => {
    const settings = settingsOf({ handlerUrl: HANDLER, timeoutMs: 1 });
    const error = await errorOf(withHandler(settings, startBudget(settings), never));
    assert.equal(error.code, "timeout");
    assert.equal(error.message, "Loading handlerUrl did not finish within the 1 ms budget.");
    assert.equal(error.details.code === "timeout" ? error.details.backend : "", "etherscan-v2");
  });

  it("throws a TypeError for a table or handlerUrl code that no caller passed and no Missing explains", async () => {
    const table: unknown = await runVerify(
      input(),
      { fetch: noRequest },
      { backends: { sourcify: sourcifyBackend } },
    ).catch((error: unknown) => error);
    assert.ok(table instanceof TypeError);
    assert.equal(table.message, "No routing table was passed to the flow engine.");
    const handler: unknown = await runVerify(
      input(),
      { fetch: noRequest, handlerUrl: HANDLER },
      { backends: { sourcify: sourcifyBackend } },
    ).catch((error: unknown) => error);
    assert.ok(handler instanceof TypeError);
    assert.equal(handler.message, "No handlerUrl code was passed to the flow engine.");
  });

  it("throws a TypeError when a client that takes constructor arguments came without it", async () => {
    const answer = answering(() => recorded("etherscan", "2026-11-03-getsourcecode-not-verified"));
    const outcome: unknown = await runVerify(
      { ...input(), creationBytecode: "0x6080" },
      {
        fetch: answer.fetch,
        route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api", apiKey: KEY },
      },
      { backends: { "etherscan-v2": etherscan } },
    ).catch((error: unknown) => error);
    assert.ok(outcome instanceof TypeError);
    assert.equal(
      outcome.message,
      "The etherscan-v2 client came without the constructor argument code.",
    );
  });
});

/** The relative imports of a module, resolved to files under src. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/^(?:import|export)\s[^;]*?from\s+"(\.{1,2}\/[^"]+)";/gms)].map(
    (match) => path.resolve(path.dirname(file), String(match[1])),
  );
}

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

describe("explorer-verify/core holds no dynamic import() (decision 0052)", () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
  it("no module that core, the clients or the table import has an import() call", () => {
    const entries = [
      path.join(src, "core/index.ts"),
      path.join(src, "core/table.ts"),
      ...readdirSync(path.join(src, "clients")).map((name) => path.join(src, "clients", name)),
    ];
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file) || !file.endsWith(".ts")) {
        continue;
      }
      seen.add(file);
      queue.push(...importsOf(file));
    }
    const lazy = [...seen].filter((file) => /\bimport\(\s*["']/.test(readFileSync(file, "utf8")));
    assert.deepEqual(lazy, []);
    // The walk reached the engine, and not the default entry's loaders.
    assert.ok(seen.has(path.join(src, "flow/verify.ts")));
    assert.ok(!seen.has(path.join(src, "flow/defaults.ts")));
    assert.ok(!seen.has(path.join(src, "routing/load-table.ts")));
  });
});
