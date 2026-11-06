// Tests added after the first mutation run of src/input/constructor-args.ts (#202; R-IN-3,
// R-DX-5, R-SEC-1): each one fails on a code change that the other derivation tests let pass. They
// call withDerivedArgs directly, with a fake client and a scripted JSON-RPC endpoint.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import type { Backend } from "../../src/backends/backend.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import type { Hex, LogFields, VerifyInput } from "../../src/index.ts";
import { withDerivedArgs } from "../../src/input/constructor-args.ts";
import { createObserver } from "../../src/observe.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { resolveRoute } from "../helpers/route.ts";

const CHAIN_ID = 11155111;
const KEY = "zz9dummyexplorerkeyqq7xv";
const API_URL = "https://explorer.example.org/api";
const ENDPOINT = { apiBase: "https://rpc.example.org/v2", search: "" };
const TX_HASH: Hex = `0x${"cd".repeat(32)}`;

interface Deployment {
  readonly address: Hex;
  readonly constructorArgs: Hex;
  readonly creationBytecode: Hex;
}

function hexOf(value: unknown): Hex {
  assert.ok(typeof value === "string" && value.startsWith("0x"));
  return `0x${value.slice(2)}`;
}

function readGreeter(): Deployment {
  const url = new URL(
    "../fixtures/constructor-args/2026-11-04-sepolia-deployments.json",
    import.meta.url,
  );
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  const greeter: unknown = Reflect.get(Object(parsed), "greeter");
  return {
    address: hexOf(Reflect.get(Object(greeter), "address")),
    constructorArgs: hexOf(Reflect.get(Object(greeter), "constructorArgs")),
    creationBytecode: hexOf(Reflect.get(Object(greeter), "creationBytecode")),
  };
}

const GREETER = readGreeter();
// The creation code: the compiled bytecode, then the arguments.
const CREATION = `${GREETER.creationBytecode}${GREETER.constructorArgs.slice(2)}`;

function input(extra: Partial<VerifyInput> = {}): VerifyInput {
  return {
    chainId: CHAIN_ID,
    address: GREETER.address,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: { language: "Solidity", sources: { "src/A.sol": { content: "" } }, settings: {} },
    },
    contractName: "src/A.sol:A",
    ...extra,
  };
}

interface Line {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

interface RpcCall {
  readonly method: string;
  readonly params: unknown;
}

/** JSON-RPC results by method; "hang" waits for the request's signal. A missing method rejects. */
type RpcScript = Readonly<Record<string, unknown>>;

interface Setup {
  /** The client's creation code, or what it throws. Absent: the client cannot read it. */
  readonly explorer?: () => Promise<string | undefined>;
  readonly strict?: boolean;
  /** Whether the route has a key bound, so the explorer may be asked. Defaults to true. */
  readonly key?: boolean;
  readonly rpc?: RpcScript;
  readonly signal?: AbortSignal;
  readonly onFetch?: () => void;
}

function backendOf(setup: Setup): Backend {
  const base: Backend = {
    name: "etherscan-compatible",
    takesConstructorArgs: true,
    lookup: async () => await Promise.resolve(undefined),
    submit: async () => await Promise.resolve({ state: "already-verified", match: "partial" }),
    poll: async () => await Promise.resolve({ state: "pending" }),
    explorerUrl: () => undefined,
  };
  const { explorer } = setup;
  return {
    ...base,
    ...(explorer === undefined ? {} : { creationCode: async () => await explorer() }),
    ...(setup.strict === true ? { refusesOtherBuilds: true } : {}),
  };
}

async function run(
  setup: Setup,
  extra: Partial<VerifyInput> = {},
): Promise<{ result: VerifyInput; lines: Line[]; calls: RpcCall[] }> {
  const lines: Line[] = [];
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields });
    };
  const observer = createObserver({
    logger: { debug: () => {}, info: record("info"), warn: record("warn"), error: record("error") },
    secrets: [],
  });
  const calls: RpcCall[] = [];
  const fetchFake = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    setup.onFetch?.();
    const raw = init?.body;
    const body: unknown = JSON.parse(typeof raw === "string" ? raw : "{}");
    const method = String(Reflect.get(Object(body), "method"));
    calls.push({ method, params: Reflect.get(Object(body), "params") });
    const script = setup.rpc ?? {};
    if (!Object.hasOwn(script, method)) {
      throw new Error("no scripted answer");
    }
    const result = script[method];
    if (result === "hang") {
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const route = resolveRoute(CHAIN_ID, {
    backend: "etherscan-compatible",
    apiUrl: API_URL,
    ...(setup.key === false ? {} : { apiKey: KEY }),
  });
  const pending = withDerivedArgs(
    {
      backend: backendOf(setup),
      ctx: {
        route,
        http: {
          backend: "etherscan-compatible",
          secrets: [],
          fetch: fetchFake,
          random: () => 0,
          ...(setup.signal === undefined ? {} : { signal: setup.signal }),
        },
      },
      settings: { rpcUrl: setup.rpc === undefined ? undefined : ENDPOINT },
      observer,
      target: { chainId: CHAIN_ID, address: GREETER.address },
    },
    input(extra),
    GREETER.creationBytecode,
  );
  await driveMockClock(pending, () => {
    mock.timers.runAll();
  });
  return { result: await pending, lines, calls };
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error: unknown) {
    return error;
  }
  return assert.fail("expected a rejection");
}

/** The log line that says why no arguments were derived (decision 0032). */
function skipLine(reason: string, text: string, level = "warn"): Line {
  return {
    level,
    message: `${text}; submitting without constructor arguments (${reason})`,
    fields: { backend: "etherscan-compatible", reason },
  };
}

const CREATED = { to: null, input: CREATION };
const RPC_OK: RpcScript = {
  eth_chainId: "0xaa36a7",
  eth_getTransactionByHash: CREATED,
  eth_getTransactionReceipt: { contractAddress: GREETER.address },
};

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
});

afterEach(() => {
  mock.timers.reset();
});

describe("withDerivedArgs: log lines (#202, R-IN-3, R-DX-5)", () => {
  it("says why no source was asked, at info, naming the backend", async () => {
    const { result, lines } = await run({ key: false });
    assert.equal(result.constructorArgs, undefined);
    assert.deepEqual(lines, [
      skipLine(
        "no-source",
        "No rpcUrl with creationTxHash and no explorer key to read the creation code",
        "info",
      ),
    ]);
  });

  it("does not ask a client that cannot read the creation code, even with a key", async () => {
    const { lines } = await run({});
    assert.deepEqual(lines, [
      skipLine(
        "no-source",
        "No rpcUrl with creationTxHash and no explorer key to read the creation code",
        "info",
      ),
    ]);
  });

  it("says no source gave the creation code when the explorer has no record", async () => {
    const { lines } = await run({ explorer: async () => await Promise.resolve(undefined) });
    assert.deepEqual(lines, [skipLine("no-creation-code", "No source gave the creation code")]);
  });

  it("logs an explorer error that means no answer, then goes on without arguments", async () => {
    const { lines } = await run({
      explorer: async () =>
        await Promise.reject(
          new ExplorerVerifyError(
            { code: "network", backend: "etherscan-compatible", attempts: 3 },
            "No answer.",
            { secrets: [] },
          ),
        ),
    });
    assert.deepEqual(lines, [
      {
        level: "warn",
        message: "The explorer gave no creation code this time",
        fields: { code: "network" },
      },
      skipLine("no-creation-code", "No source gave the creation code"),
    ]);
  });

  it("names a creation code that does not start with creationBytecode or has a partial word", async () => {
    const other = `0x00${CREATION.slice(4)}`;
    const partial = `${CREATION}00`;
    const { lines: mismatch } = await run({ explorer: async () => await Promise.resolve(other) });
    assert.deepEqual(mismatch, [
      skipLine("prefix-mismatch", "The creation code does not start with creationBytecode"),
    ]);
    const { lines: length } = await run({ explorer: async () => await Promise.resolve(partial) });
    assert.deepEqual(length, [
      skipLine("bad-length", "What follows creationBytecode is not whole 32-byte words"),
    ]);
  });

  it("logs the size of the derived arguments in bytes", async () => {
    const { result, lines } = await run({ explorer: async () => await Promise.resolve(CREATION) });
    assert.equal(result.constructorArgs, GREETER.constructorArgs);
    assert.deepEqual(lines, [
      {
        level: "info",
        message: "Derived the constructor arguments from the creation code",
        fields: {
          backend: "etherscan-compatible",
          bytes: (GREETER.constructorArgs.length - 2) / 2,
        },
      },
    ]);
  });

  it("strips only the leading 0x of a creation code", async () => {
    // Text that is not hex after creationBytecode is not taken for arguments.
    const odd = `${GREETER.creationBytecode.slice(2)}0x${GREETER.constructorArgs.slice(2)}`;
    const { result, lines } = await run({ explorer: async () => await Promise.resolve(odd) });
    assert.equal(result.constructorArgs, undefined);
    assert.deepEqual(lines, [
      skipLine("bad-length", "What follows creationBytecode is not whole 32-byte words"),
    ]);
  });
});

describe("withDerivedArgs: JSON-RPC reads (#202, R-IN-3)", () => {
  it("sends eth_chainId without parameters and the receipt request with the transaction hash", async () => {
    const { result, calls } = await run({ rpc: RPC_OK }, { creationTxHash: TX_HASH });
    assert.equal(result.constructorArgs, GREETER.constructorArgs);
    assert.deepEqual(calls, [
      { method: "eth_chainId", params: [] },
      { method: "eth_getTransactionByHash", params: [TX_HASH] },
      { method: "eth_getTransactionReceipt", params: [TX_HASH] },
    ]);
  });

  it("does not use a transaction input with text around the hex, or that is not a string", async () => {
    for (const data of ["zz0x6080", "0x6080zz", [CREATION]]) {
      const { result, lines, calls } = await run(
        { rpc: { ...RPC_OK, eth_getTransactionByHash: { to: null, input: data } } },
        { creationTxHash: TX_HASH },
      );
      assert.equal(result.constructorArgs, undefined);
      assert.deepEqual(
        calls.map((call) => call.method),
        ["eth_chainId", "eth_getTransactionByHash"],
      );
      assert.deepEqual(lines, [
        { level: "warn", message: "rpcUrl: no usable creation transaction", fields: {} },
        skipLine("no-creation-code", "No source gave the creation code"),
      ]);
    }
  });

  it("logs a receipt without a contract address", async () => {
    const { lines } = await run(
      { rpc: { ...RPC_OK, eth_getTransactionReceipt: { status: "0x1" } } },
      { creationTxHash: TX_HASH },
    );
    assert.deepEqual(lines, [
      {
        level: "warn",
        message: "rpcUrl: no usable receipt for the creation transaction",
        fields: {},
      },
      skipLine("no-creation-code", "No source gave the creation code"),
    ]);
  });

  it("explains an rpcUrl of another chain in the message, the issue and the hint", async () => {
    const error = await rejectionOf(
      run({ rpc: { ...RPC_OK, eth_chainId: "0x1" } }, { creationTxHash: TX_HASH }),
    );
    assert.ok(error instanceof ExplorerVerifyError);
    assert.equal(error.message, "The options are invalid: rpcUrl.");
    assert.equal(error.hint, "Pass a JSON-RPC endpoint of the contract's chain as rpcUrl.");
    assert.deepEqual(error.details, {
      code: "invalid-input",
      issues: [{ field: "rpcUrl", message: "serves another chain than chainId" }],
    });
  });

  it("rejects with the signal's reason, unchanged, even when it is an ExplorerVerifyError (R-FLOW-6)", async () => {
    const reasons = [
      new Error("stopped by the caller"),
      new ExplorerVerifyError(
        { code: "network", backend: "etherscan-compatible", attempts: 1 },
        "Stop.",
        {
          secrets: [],
        },
      ),
    ];
    for (const reason of reasons) {
      const controller = new AbortController();
      const error = await rejectionOf(
        run(
          {
            rpc: { ...RPC_OK, eth_chainId: "hang" },
            signal: controller.signal,
            explorer: async () => await Promise.resolve(CREATION),
            onFetch: () => {
              queueMicrotask(() => {
                controller.abort(reason);
              });
            },
          },
          { creationTxHash: TX_HASH },
        ),
      );
      assert.equal(error, reason);
    }
  });
});

describe("withDerivedArgs: a mismatch on a client that refuses another build (#202, R-IN-3)", () => {
  it("throws prefix-mismatch when a trailing placeholder runs past the creation code", async () => {
    const placeholder = `__$${"ab".repeat(17)}$__`;
    const compiled = `${GREETER.creationBytecode}${placeholder}`;
    const lines: string[] = [];
    const error = await rejectionOf(
      withDerivedArgs(
        {
          backend: backendOf({
            explorer: async () => await Promise.resolve(GREETER.creationBytecode),
            strict: true,
          }),
          ctx: {
            route: resolveRoute(CHAIN_ID, {
              backend: "etherscan-compatible",
              apiUrl: API_URL,
              apiKey: KEY,
            }),
            http: { backend: "etherscan-compatible", secrets: [] },
          },
          settings: { rpcUrl: undefined },
          observer: createObserver({
            logger: {
              debug: () => {},
              info: (message) => lines.push(message),
              warn: (message) => lines.push(message),
              error: () => {},
            },
            secrets: [],
          }),
          target: { chainId: CHAIN_ID, address: GREETER.address },
        },
        input(),
        hexOf(compiled),
      ),
    );
    assert.ok(error instanceof ExplorerVerifyError);
    assert.deepEqual(error.details, {
      code: "constructor-args-unavailable",
      reason: "prefix-mismatch",
    });
    assert.equal(
      error.message,
      `The creation code of ${GREETER.address} does not start with creationBytecode: the input differs from the deployed build.`,
    );
  });

  it("throws bad-length with its own message", async () => {
    const error = await rejectionOf(
      run({ explorer: async () => await Promise.resolve(`${CREATION}00`), strict: true }),
    );
    assert.ok(error instanceof ExplorerVerifyError);
    assert.deepEqual(error.details, { code: "constructor-args-unavailable", reason: "bad-length" });
    assert.equal(
      error.message,
      `What follows creationBytecode in the creation code of ${GREETER.address} is not whole 32-byte words.`,
    );
  });
});
