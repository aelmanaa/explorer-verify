// A lazy module that fails to load, such as a chunk the page cannot fetch, rejects with an
// ExplorerVerifyError `network`: retryable, with a hint, the loader's error as its cause, and no
// request sent (R-DX-3, decision 0054). Abort and timeout during a load stay as decision 0031
// says; their tests are in lazy-clients, table-on-demand and derivation-load.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Backend } from "../../src/backends/backend.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { ERROR_HINTS } from "../../src/error-hints.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import type { FlowDependencies } from "../../src/flow/verify.ts";
import { ROUTING_TABLE } from "../../src/routing/table.ts";
import type { VerifyInput, VerifyOptions } from "../../src/types.ts";
import { runCheckStatus, runVerify } from "../helpers/defaults.ts";

const SEPOLIA = 11155111;
const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const KEY = "dummy-key-lazy-236";
const INPUT: VerifyInput = {
  chainId: SEPOLIA,
  address: ADDRESS,
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

/**
 * What a browser throws when a chunk cannot be fetched. The key of {@link OPTIONS} is in it, to
 * check that the cause is redacted: a real chunk URL holds none.
 */
function chunkError(): TypeError {
  return new TypeError(`Failed to fetch dynamically imported module: /assets/chunk.js?k=${KEY}`);
}

/** A fetch that records each request: a failed load must send none. */
function recordingFetch(): { readonly fetch: typeof fetch; readonly urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url instanceof Request ? url.url : url.toString());
      return await Promise.reject(new Error("no request expected"));
    },
  };
}

/** Sourcify's client, answering every lookup with an exact match and no request. */
const exactSourcify: Backend = {
  ...sourcify,
  lookup: async () => await Promise.resolve("exact"),
};

/** The rejection of `promise`, which must be an ExplorerVerifyError. */
async function errorOf(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof ExplorerVerifyError, String(error));
  return error;
}

/** Checks the fields every failed load has, and that no key and no request escaped. */
function assertFailedLoad(
  error: ExplorerVerifyError,
  what: string,
  backend: string,
  urls: readonly string[],
): void {
  assert.equal(error.code, "network");
  assert.deepEqual(error.details, { code: "network", backend, attempts: 1 });
  assert.equal(error.retryable, true);
  assert.equal(error.message, `Loading ${what} failed.`);
  assert.notEqual(error.hint, ERROR_HINTS.network);
  assert.match(error.hint, /serves every file of its build/);
  assert.ok(error.cause instanceof Error);
  assert.equal(error.cause.name, "TypeError");
  assert.match(error.cause.message, /^Failed to fetch dynamically imported module/);
  assert.ok(!JSON.stringify(error).includes(KEY));
  assert.ok(!error.cause.message.includes(KEY));
  assert.deepEqual(urls, []);
}

const OPTIONS: VerifyOptions = { apiKeys: { "etherscan-v2": KEY } };

describe("a lazy module that fails to load rejects with network (R-DX-3, decision 0054)", () => {
  it("a client", async () => {
    const { fetch, urls } = recordingFetch();
    const dependencies: FlowDependencies = {
      backends: { sourcify: async () => await Promise.reject(chunkError()) },
      table: ROUTING_TABLE,
    };
    const error = await errorOf(runVerify(INPUT, { ...OPTIONS, fetch }, dependencies));
    assertFailedLoad(error, "the sourcify client", "sourcify", urls);
  });

  it("the routing table, naming route.backend", async () => {
    const { fetch, urls } = recordingFetch();
    const dependencies: FlowDependencies = {
      backends: { sourcify: exactSourcify, blockscout: exactSourcify },
      table: async () => await Promise.reject(chunkError()),
    };
    const error = await errorOf(
      runVerify(INPUT, { ...OPTIONS, fetch, route: { backend: "blockscout" } }, dependencies),
    );
    assertFailedLoad(error, "the routing table", "blockscout", urls);
  });

  it("the routing table, through checkStatus()", async () => {
    const { fetch, urls } = recordingFetch();
    const dependencies: FlowDependencies = {
      backends: { sourcify: exactSourcify },
      table: async () => await Promise.reject(chunkError()),
    };
    const error = await errorOf(
      runCheckStatus(
        `ev1:sourcify:${String(SEPOLIA)}:${ADDRESS}:job-1`,
        { ...OPTIONS, fetch },
        dependencies,
      ),
    );
    assertFailedLoad(error, "the routing table", "sourcify", urls);
  });

  it("the handlerUrl code", async () => {
    const { fetch, urls } = recordingFetch();
    const dependencies: FlowDependencies = {
      backends: { sourcify: exactSourcify },
      table: ROUTING_TABLE,
      // No apiKeys with handlerUrl: the server handler holds the key, so the cause holds none.
      handler: async () =>
        await Promise.reject(new TypeError("Failed to fetch dynamically imported module")),
    };
    const error = await errorOf(
      runVerify(INPUT, { fetch, handlerUrl: "https://dapp.example/api/verify" }, dependencies),
    );
    assertFailedLoad(error, "handlerUrl", "etherscan-v2", urls);
  });

  it("removes an rpcUrl secret from the cause too (R-SEC-1)", async () => {
    const { fetch } = recordingFetch();
    const secret = "rpc-secret-236";
    const dependencies: FlowDependencies = {
      backends: {
        sourcify: async () =>
          await Promise.reject(new TypeError(`Failed to fetch /chunk.js?${secret}`)),
      },
      table: ROUTING_TABLE,
    };
    const error = await errorOf(
      runVerify(INPUT, { fetch, rpcUrl: `https://rpc.example/${secret}` }, dependencies),
    );
    assert.ok(error.cause instanceof Error);
    assert.ok(!error.cause.message.includes(secret), error.cause.message);
  });
});
