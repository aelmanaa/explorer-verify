// Tests added when verifyEach() joined mutation testing (#194; R-RT-4, R-IN-6, R-SEC-1): each one
// fails on a code change in src/flow/verify-each.ts that the other verifyEach() tests let pass.
// No test here waits: every call ends before a request, or on the first answer.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Backend } from "../../src/backends/backend.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import type { InputIssue } from "../../src/errors.ts";
import { MAX_BACKENDS } from "../../src/flow/verify-each.ts";
import type { FlowDependencies } from "../../src/flow/verify.ts";
import type { RoutingTable } from "../../src/routing/resolve.ts";
import type { VerifyInput } from "../../src/types.ts";
import { runVerifyEach } from "../helpers/defaults.ts";
import { keptAlive } from "../helpers/kept-alive.ts";

const SEPOLIA = 11155111;
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
// A fake key. Never a real one (R-SEC-1).
const ROUTE_KEY = "dummy-route-key-each-mutants-7q3z";
const HINT =
  'Pass backends as "all" or as an array of backend names or route overrides that name their backend, each backend and API URL once, no key in the address. Put each route in its backends entry, not in route.';

const TABLE: RoutingTable = {
  schemaVersion: 2,
  checked: "2026-11-05",
  chains: [
    { chainId: SEPOLIA, backends: [{ backend: "sourcify" }] },
    // A row with no backend, and a row whose Routescan entry names no network.
    { chainId: 100_001, backends: [] },
    { chainId: 100_002, backends: [{ backend: "routescan" }] },
  ],
};

const DEPENDENCIES: FlowDependencies = { backends: { sourcify }, table: TABLE, random: () => 0 };

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

/** A fetch that must not be called. */
const unreachable: typeof fetch = async () =>
  await Promise.reject(new Error("no request expected"));

/** Runs runVerifyEach() with options of any shape, and gives what it resolved or rejected with. */
async function outcomeOf(
  options: unknown,
  dependencies: FlowDependencies = DEPENDENCIES,
  value: VerifyInput = input(),
): Promise<unknown> {
  const pending: unknown = Reflect.apply(runVerifyEach, undefined, [value, options, dependencies]);
  return await Promise.resolve(pending).then(
    (result: unknown) => result,
    (error: unknown) => error,
  );
}

/** `count` Sourcify entries, each on its own host. */
function entries(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    backend: "sourcify",
    apiUrl: `https://sourcify-${String(index)}.example/server`,
  }));
}

/** The invalid-input error of `outcome`, with its message, hint and every issue. */
function invalid(outcome: unknown): {
  message: string;
  hint: string;
  issues: readonly InputIssue[];
} {
  assert.ok(
    outcome instanceof ExplorerVerifyError,
    `expected an error, got ${JSON.stringify(outcome)}`,
  );
  assert.ok(outcome.details.code === "invalid-input", outcome.message);
  return { message: outcome.message, hint: outcome.hint, issues: outcome.details.issues };
}

describe("verifyEach(): every issue of the options, with its message (R-IN-6)", () => {
  it("names a top-level route, with the hint", async () => {
    assert.deepEqual(
      invalid(await outcomeOf({ backends: ["sourcify"], route: { backend: "sourcify" } })),
      {
        message: "The options are invalid: route.",
        hint: HINT,
        issues: [
          {
            field: "route",
            message: "is not used by verifyEach(); set it in an entry of backends",
          },
        ],
      },
    );
  });

  it(`accepts ${String(MAX_BACKENDS)} entries and refuses one more`, async () => {
    // route makes the call throw before any request, so only the issues of backends differ.
    const route = { backend: "sourcify" };
    assert.deepEqual(
      invalid(await outcomeOf({ backends: entries(MAX_BACKENDS), route })).issues.map(
        (issue) => issue.field,
      ),
      ["route"],
    );
    assert.deepEqual(invalid(await outcomeOf({ backends: entries(MAX_BACKENDS + 1), route })), {
      message: "The options are invalid: route, backends.",
      hint: HINT,
      issues: [
        { field: "route", message: "is not used by verifyEach(); set it in an entry of backends" },
        {
          field: "backends",
          message: `must be "all" or an array of 1 to ${String(MAX_BACKENDS)} entries`,
        },
      ],
    });
  });

  it("names each bad entry with its message", async () => {
    const known = "must name a known backend";
    const shape = "must be a backend name or a plain object whose backend names a known backend";
    assert.deepEqual(
      invalid(
        await outcomeOf({
          backends: [
            "nope",
            {},
            { backend: 5 },
            { backend: "sourcify", apiUrl: 1 },
            42,
            null,
            ["sourcify"],
          ],
        }),
      ),
      {
        message:
          "The options are invalid: backends[0], backends[1].backend, backends[2].backend, backends[3].apiUrl, backends[4], backends[5], backends[6].",
        hint: HINT,
        issues: [
          { field: "backends[0]", message: known },
          { field: "backends[1].backend", message: known },
          { field: "backends[2].backend", message: known },
          { field: "backends[3].apiUrl", message: "must be a string" },
          { field: "backends[4]", message: shape },
          { field: "backends[5]", message: shape },
          { field: "backends[6]", message: "must be a plain object" },
        ],
      },
    );
  });

  it("reads an entry whose prototype is null", async () => {
    const entry: { backend?: unknown } = Object.create(null);
    entry.backend = "sourcify";
    const outcome = await outcomeOf({ backends: [entry, "sourcify"], fetch: unreachable });
    // The two entries are the same backend and API URL: the null-prototype entry was read.
    assert.deepEqual(invalid(outcome).issues, [
      { field: "backends[1]", message: "resolves to the backend and API URL of an earlier entry" },
    ]);
  });

  it("names each repeated backend, with the message and the hint", async () => {
    const repeated = "resolves to the backend and API URL of an earlier entry";
    assert.deepEqual(invalid(await outcomeOf({ backends: ["sourcify", "sourcify", "sourcify"] })), {
      message: "The options are invalid: backends[1], backends[2].",
      hint: HINT,
      issues: [
        { field: "backends[1]", message: repeated },
        { field: "backends[2]", message: repeated },
      ],
    });
  });

  it("names a key found in the address once, however many entries share the handle", async () => {
    const outcome = await outcomeOf({
      backends: ["sourcify", { backend: "sourcify", apiUrl: "https://sourcify.example/server" }],
      apiKeys: { routescan: GREETER.slice(10, 22) },
    });
    assert.deepEqual(
      invalid(outcome).issues.map((issue) => issue.field),
      ["apiKeys.routescan"],
    );
  });

  it("names the entry of a refused apiUrl when the entry has no apiKey (R-SEC-1)", async () => {
    const outcome = await outcomeOf({
      backends: [{ backend: "sourcify", apiUrl: "http://evil.example/x" }],
    });
    assert.deepEqual(
      invalid(outcome).issues.map((issue) => issue.field),
      ["backends[0].apiUrl"],
    );
  });

  it("names the entry in the message of an entry's route error, each field once", async () => {
    const { message } = invalid(
      await outcomeOf({
        backends: [{ backend: "sourcify", apiUrl: "ftp://a.example", apiKey: "k1234567890" }],
      }),
    );
    assert.equal(
      message,
      "The backends option is invalid: backends[0].apiUrl, backends[0].apiKey.",
    );
  });
});

describe("verifyEach(): entries the chain's row does not list (R-RT-4)", () => {
  // Clients for Blockscout and Routescan, which the Sepolia row of the test table does not list.
  const UNLISTED: FlowDependencies = {
    ...DEPENDENCIES,
    backends: { sourcify, blockscout: sourcify, routescan: sourcify },
  };

  it("gives each its own unsupported-chain outcome", async () => {
    const result = await outcomeOf(
      { backends: ["blockscout", "routescan"], fetch: unreachable },
      UNLISTED,
    );
    assert.ok(!(result instanceof Error), String(result));
    assert.deepEqual(result, {
      outcomes: [
        { backend: "blockscout", ok: false, error: outcomesError(result, 0) },
        { backend: "routescan", ok: false, error: outcomesError(result, 1) },
      ],
    });
  });

  it("names the second of two entries for the same unlisted backend", async () => {
    assert.deepEqual(
      invalid(await outcomeOf({ backends: ["blockscout", "blockscout"] }, UNLISTED)).issues,
      [
        {
          field: "backends[1]",
          message: "resolves to the backend and API URL of an earlier entry",
        },
      ],
    );
  });
});

/** The unsupported-chain error of outcome `index`. */
function outcomesError(result: unknown, index: number): ExplorerVerifyError {
  assert.ok(typeof result === "object" && result !== null);
  const outcomes: unknown = Reflect.get(result, "outcomes");
  assert.ok(Array.isArray(outcomes));
  const outcome: unknown = outcomes[index];
  assert.ok(typeof outcome === "object" && outcome !== null);
  const error: unknown = Reflect.get(outcome, "error");
  assert.ok(error instanceof ExplorerVerifyError);
  assert.equal(error.code, "unsupported-chain");
  return error;
}

describe('verifyEach(): "all" (R-RT-4, R-RT-3)', () => {
  it("throws unsupported-chain for Sourcify on a chain without a row", async () => {
    const error = await outcomeOf({ backends: "all" }, DEPENDENCIES, input(999_999));
    assert.ok(error instanceof ExplorerVerifyError);
    assert.deepEqual(error.details, {
      code: "unsupported-chain",
      chainId: 999_999,
      backend: "sourcify",
    });
    assert.equal(error.message, "The routing table has no row for chain 999999.");
  });

  it("throws unsupported-chain for Sourcify on a row with no backend", async () => {
    const error = await outcomeOf({ backends: "all" }, DEPENDENCIES, input(100_001));
    assert.ok(error instanceof ExplorerVerifyError);
    assert.deepEqual(error.details, {
      code: "unsupported-chain",
      chainId: 100_001,
      backend: "sourcify",
    });
    assert.equal(
      error.message,
      "This version has no sourcify client, the routing table's choice for chain 100001.",
    );
  });

  it("runs a listed backend whose table entry gives no API, as its unsupported-chain outcome", async () => {
    const result = await outcomeOf(
      { backends: "all", fetch: unreachable },
      { ...DEPENDENCIES, backends: { routescan: sourcify } },
      input(100_002),
    );
    assert.ok(!(result instanceof Error), String(result));
    outcomesError(result, 0);
  });
});

describe("verifyEach(): keys and client loads (R-SEC-1, decision 0031)", () => {
  const ROUTED = {
    backend: "routescan",
    apiUrl: "https://explorer.example.org/api",
    apiKey: ROUTE_KEY,
  };
  /** A Routescan client whose explorer is down. */
  const down: Backend = {
    name: "routescan",
    lookup: async () =>
      await Promise.reject(
        new ExplorerVerifyError({ code: "network", backend: "routescan", attempts: 1 }, "down", {
          secrets: [],
        }),
      ),
    submit: async () => await Promise.reject(new Error("no submit expected")),
    poll: async () => await Promise.reject(new Error("no poll expected")),
    explorerUrl: () => undefined,
  };
  const KEYED: FlowDependencies = { ...DEPENDENCIES, backends: { sourcify, routescan: down } };

  it("removes an entry's key from another backend's error", async () => {
    const echo: typeof fetch = async () =>
      await Promise.resolve(
        new Response(JSON.stringify({ match: `odd ${ROUTE_KEY}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const result = await outcomeOf({ backends: ["sourcify", ROUTED], fetch: echo }, KEYED);
    assert.ok(!(result instanceof Error), String(result));
    const printed = JSON.stringify(result);
    assert.ok(printed.includes("unexpected-response"), printed);
    assert.ok(!printed.includes(ROUTE_KEY), printed);
  });

  it("names the client in a failed load, and removes every key from its cause", async () => {
    const result = await outcomeOf(
      { backends: ["sourcify", ROUTED], fetch: unreachable },
      {
        ...KEYED,
        backends: {
          routescan: down,
          sourcify: async (): Promise<Backend> =>
            await Promise.reject(new TypeError(`chunk ${ROUTE_KEY} failed`)),
        },
      },
    );
    assert.ok(!(result instanceof Error), String(result));
    assert.ok(typeof result === "object" && result !== null);
    const outcomes: unknown = Reflect.get(result, "outcomes");
    assert.ok(Array.isArray(outcomes));
    const error: unknown = Reflect.get(outcomes[0], "error");
    assert.ok(error instanceof ExplorerVerifyError);
    assert.equal(error.code, "network");
    assert.equal(error.message, "Loading the sourcify client failed.");
    assert.ok(error.cause instanceof Error);
    assert.ok(!error.cause.message.includes(ROUTE_KEY), error.cause.message);
  });
});

const chunkError = new TypeError("Failed to fetch dynamically imported module");
/** Clients for Sourcify and Blockscout, and a table loader that fails. */
const FAILING: FlowDependencies = {
  backends: { sourcify, blockscout: sourcify },
  table: async () => await Promise.reject(chunkError),
  random: () => 0,
};

/** A table loader that never settles. */
async function never(): Promise<RoutingTable> {
  return await new Promise<RoutingTable>(() => undefined);
}

describe("verifyEach(): a routing table that fails to load (R-RT-4, decision 0040)", () => {
  it("gives each entry that reads the table its own outcome, Blockscout instances by API URL", async () => {
    const result = await outcomeOf(
      {
        backends: [
          "sourcify",
          { backend: "blockscout", apiUrl: "https://eth-sepolia.blockscout.com/api" },
          { backend: "blockscout", apiUrl: "https://base-sepolia.blockscout.com/api" },
        ],
        fetch: unreachable,
        signal: new AbortController().signal,
      },
      FAILING,
    );
    assert.ok(!(result instanceof Error), String(result));
    for (const index of [0, 1, 2]) {
      assert.equal(outcomeError(result, index).code, "network");
    }
  });

  it("names the second entry for the same instance, its URL in another case", async () => {
    const duplicate = await outcomeOf(
      {
        backends: [
          { backend: "blockscout", apiUrl: "https://eth-sepolia.blockscout.com/api" },
          { backend: "blockscout", apiUrl: "https://ETH-SEPOLIA.blockscout.com/api/" },
        ],
        fetch: unreachable,
      },
      FAILING,
    );
    assert.deepEqual(invalid(duplicate).issues, [
      { field: "backends[1]", message: "resolves to the backend and API URL of an earlier entry" },
    ]);
  });

  it("rejects with the abort reason when the signal aborts during the load, and emits nothing", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const events: unknown[] = [];
    const outcome = await outcomeOf(
      {
        backends: ["sourcify"],
        fetch: unreachable,
        signal: controller.signal,
        onEvent: (event: unknown) => {
          events.push(event);
        },
      },
      {
        ...FAILING,
        table: async () => {
          controller.abort(reason);
          return await Promise.reject(chunkError);
        },
      },
    );
    assert.equal(outcome, reason);
    assert.deepEqual(events, []);
  });

  it('names Sourcify in the timeout of a table load for "all"', async () => {
    const outcome = await keptAlive(
      async () =>
        await outcomeOf(
          { backends: "all", fetch: unreachable, timeoutMs: 5 },
          { ...FAILING, table: never },
        ),
    );
    assert.ok(outcome instanceof ExplorerVerifyError, String(outcome));
    assert.deepEqual(outcome.details, { code: "timeout", backend: "sourcify", timeoutMs: 5 });
  });
});

/** The error of outcome `index`. */
function outcomeError(result: unknown, index: number): ExplorerVerifyError {
  assert.ok(typeof result === "object" && result !== null);
  const outcomes: unknown = Reflect.get(result, "outcomes");
  assert.ok(Array.isArray(outcomes));
  const outcome: unknown = outcomes[index];
  assert.ok(typeof outcome === "object" && outcome !== null);
  const error: unknown = Reflect.get(outcome, "error");
  assert.ok(error instanceof ExplorerVerifyError, JSON.stringify(outcome));
  return error;
}
