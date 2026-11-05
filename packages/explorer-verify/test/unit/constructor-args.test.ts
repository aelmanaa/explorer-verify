// Constructor argument derivation (R-IN-3, #64), through verify() with a fake fetch that replays
// answers recorded on Ethereum Sepolia on 2026-11-04 (test/fixtures/constructor-args/, rpc/ and
// etherscan/). Time runs on node:test mock timers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { inspect } from "node:util";

import type { Backend } from "../../src/backends/backend.ts";
import { blockscout } from "../../src/backends/blockscout.ts";
import { etherscanCompatible } from "../../src/backends/etherscan-compatible.ts";
import { etherscan } from "../../src/backends/etherscan.ts";
import { routescan } from "../../src/backends/routescan.ts";
import { runVerify } from "../../src/flow/verify.ts";
import {
  ERROR_EXIT_CODES,
  ExplorerVerifyError,
  buildVerifyInput,
  validateInput,
  verify,
} from "../../src/index.ts";
import type {
  Hex,
  LogFields,
  Logger,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../../src/index.ts";
import { withDerivedArgs } from "../../src/input/constructor-args.ts";
import { createObserver } from "../../src/observe.ts";
import { loadFixture, responseOf } from "../helpers/fake-fetch.ts";
import { driveMockClock, turnUntil } from "../helpers/mock-clock.ts";
import { resolveRoute } from "../helpers/route.ts";

const KEY = "zz9dummyetherscankeyqq7xv";
const RPC_SECRET = "rpcsecretpath0123456789";
const RPC_URL = `https://rpc.example.org/v2/${RPC_SECRET}`;
const GUID = "yatwfd5yijmxufgkexd8ygesyexubjazunjnbgkemvwbm7vhrw";
const CHAIN_ID = 11155111;
const VERSION = "0.8.24+commit.e11b9ed9";

interface Deployment {
  readonly contractName: string;
  readonly address: Hex;
  readonly creationTxHash: Hex;
  readonly constructorArgs: Hex;
  readonly creationBytecode: Hex;
}

interface Deployments {
  readonly greeter: Deployment;
  readonly factoryChild: Deployment;
  readonly create2Child: Deployment;
  readonly greeterEditedComment: { readonly creationBytecode: Hex };
  readonly sources: Readonly<Record<string, string>>;
}

/** The field `key` of an object, or `undefined`. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function hexOf(value: unknown): Hex {
  assert.ok(typeof value === "string" && value.startsWith("0x"));
  return `0x${value.slice(2)}`;
}

function deploymentOf(value: unknown): Deployment {
  const name = field(value, "contractName");
  assert.ok(typeof name === "string");
  return {
    contractName: name,
    address: hexOf(field(value, "address")),
    creationTxHash: hexOf(field(value, "creationTxHash")),
    constructorArgs: hexOf(field(value, "constructorArgs")),
    creationBytecode: hexOf(field(value, "creationBytecode")),
  };
}

function readDeployments(): Deployments {
  const url = new URL(
    "../fixtures/constructor-args/2026-11-04-sepolia-deployments.json",
    import.meta.url,
  );
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  const sources: Record<string, string> = {};
  const listed = field(parsed, "sources");
  for (const path of ["src/ArgsGreeter.sol", "src/ArgsChild.sol", "src/ArgsFactory.sol"]) {
    const content = field(listed, path);
    assert.ok(typeof content === "string");
    sources[path] = content;
  }
  return {
    greeter: deploymentOf(field(parsed, "greeter")),
    factoryChild: deploymentOf(field(parsed, "factoryChild")),
    create2Child: deploymentOf(field(parsed, "create2Child")),
    greeterEditedComment: {
      creationBytecode: hexOf(field(field(parsed, "greeterEditedComment"), "creationBytecode")),
    },
    sources,
  };
}

/** The recorded body of a fixture as JSON text, with `from` replaced by `to`. */
function edited(backend: string, name: string, from: string, to: string): Response {
  const text = JSON.stringify(loadFixture(backend, name).response.body);
  assert.ok(text.includes(from));
  return new Response(text.replace(from, to), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const DEPLOYED = readDeployments();
const GREETER = DEPLOYED.greeter;

// ---------------------------------------------------------------------------------------------
// Mock time.

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
});

afterEach(() => {
  mock.timers.reset();
});

/**
 * Settles `pending` on the mock clock with `driveMockClock` (testing.md): the clock moves only when
 * the call waits on a timer, never while a client or the derivation code loads.
 */
async function drive<T>(pending: Promise<T>): Promise<T> {
  await driveMockClock(pending, () => {
    mock.timers.runAll();
  });
  return await pending;
}

async function errorOf(promise: Promise<VerifyResult>): Promise<ExplorerVerifyError> {
  try {
    const result = await drive(promise);
    return assert.fail(`expected an error, got ${JSON.stringify(result)}`);
  } catch (error) {
    if (error instanceof ExplorerVerifyError) {
      return error;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// A fake fetch for Etherscan and a JSON-RPC endpoint.

interface Seen {
  readonly host: string;
  /** The Etherscan action, or the JSON-RPC method. */
  readonly what: string;
  readonly fields: URLSearchParams;
  readonly body: string;
}

type Answer = Response | Error | "hang";

interface Script {
  /** By JSON-RPC method. A missing method rejects. */
  readonly rpc?: Readonly<Record<string, Answer>>;
  /** The getcontractcreation answer. A missing answer rejects. */
  readonly creation?: Answer;
}

function rpcFixture(name: string): Response {
  return responseOf(loadFixture("rpc", name));
}

function etherscanFixture(name: string): Response {
  return responseOf(loadFixture("etherscan", name));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const RPC_GREETER: Readonly<Record<string, Answer>> = {
  eth_chainId: rpcFixture("2026-11-04-eth-chainid-sepolia"),
  eth_getTransactionByHash: rpcFixture("2026-11-04-eth-gettransactionbyhash-args-greeter"),
  eth_getTransactionReceipt: rpcFixture("2026-11-04-eth-gettransactionreceipt-args-greeter"),
};

function answerOf(
  answer: Answer | undefined,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  if (answer === "hang") {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        reject(new Error("aborted"));
      });
    });
  }
  if (answer === undefined) {
    return Promise.reject(new Error("no scripted answer"));
  }
  if (answer instanceof Error) {
    return Promise.reject(answer);
  }
  return fresh(answer);
}

/** Each scripted answer's body, read once. */
const BODIES = new WeakMap<Response, Promise<string>>();

/**
 * A new `Response` with the status, headers and body of `answer`, which several tests share. The
 * body is read once and kept, and every request gets a new `Response`. With `Response.clone()` of
 * the shared answer instead, the tests that reused an answer got no usable body on Node 24.0.0.
 */
async function fresh(answer: Response): Promise<Response> {
  let body = BODIES.get(answer);
  if (body === undefined) {
    body = answer.text();
    BODIES.set(answer, body);
  }
  return new Response(await body, { status: answer.status, headers: answer.headers });
}

function fake(script: Script): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const raw = init?.body;
    const body =
      typeof raw === "string" ? raw : raw instanceof URLSearchParams ? raw.toString() : "";
    if (url.host === "rpc.example.org") {
      const parsed: unknown = JSON.parse(body);
      const method =
        typeof parsed === "object" &&
        parsed !== null &&
        "method" in parsed &&
        typeof parsed.method === "string"
          ? parsed.method
          : "";
      seen.push({ host: url.host, what: method, fields: new URLSearchParams(), body });
      return await answerOf(script.rpc?.[method], init?.signal);
    }
    const fields = new URLSearchParams(body);
    const action = fields.get("action") ?? "";
    seen.push({ host: url.host, what: action, fields, body });
    switch (action) {
      case "getsourcecode":
        return json({
          status: "1",
          message: "OK",
          result: [{ SourceCode: "", ABI: "Contract source code not verified", SimilarMatch: "" }],
        });
      case "verifysourcecode":
        return json({ status: "1", message: "OK", result: GUID });
      case "checkverifystatus":
        return json({ status: "1", message: "OK", result: "Pass - Verified" });
      case "getcontractcreation":
        return await answerOf(script.creation, init?.signal);
      default:
        throw new Error(`unexpected action ${action}`);
    }
  };
  return { fetch: fetchFake, seen };
}

function inputOf(deployment: Deployment, extra: Partial<VerifyInput> = {}): VerifyInput {
  const path = deployment.contractName.slice(0, deployment.contractName.lastIndexOf(":"));
  return {
    chainId: CHAIN_ID,
    address: deployment.address,
    compiler: {
      kind: "solc",
      version: VERSION,
      input: {
        language: "Solidity",
        sources: { [path]: { content: DEPLOYED.sources[path] ?? "" } },
        settings: {},
      },
    },
    contractName: deployment.contractName,
    creationTxHash: deployment.creationTxHash,
    creationBytecode: deployment.creationBytecode,
    ...extra,
  };
}

/** The constructor arguments the submit carried, or `undefined` when it carried none. */
function submittedArgs(seen: readonly Seen[]): string | undefined {
  const submit = seen.find((each) => each.what === "verifysourcecode");
  assert.ok(submit !== undefined, "a submit was sent");
  const args = submit.fields.get("constructorArguements");
  assert.equal(submit.fields.get("constructorArguments"), args);
  return args ?? undefined;
}

/**
 * Runs `call` with a logger, and checks that no arguments were derived and the call went on: it
 * verifies, the submit carries no constructor arguments, and the reason is logged at `level`, and
 * only there (decision 0032). Returns the line that names the reason.
 */
async function expectNoArgs(
  seen: readonly Seen[],
  call: (logger: Logger) => Promise<VerifyResult>,
  reason = "no-creation-code",
  level: "info" | "warn" = "warn",
): Promise<string> {
  const lines: { level: string; text: string }[] = [];
  const record =
    (name: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level: name, text: `${message} ${JSON.stringify(fields ?? {})}` });
    };
  const logger: Logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
  const result = await drive(call(logger));
  assert.equal(result.status, "verified");
  assert.equal(submittedArgs(seen), undefined);
  const named = lines.filter((line) => line.text.includes(`"reason":"${reason}"`));
  assert.deepEqual(
    named.map((line) => line.level),
    [level],
    lines.map((line) => line.text).join("\n"),
  );
  const [line] = named;
  assert.ok(line !== undefined);
  return line.text;
}

function whats(seen: readonly Seen[]): string[] {
  return seen.map((each) => each.what);
}

const WITH_KEY: VerifyOptions = { apiKeys: { "etherscan-v2": KEY } };
// An Etherscan route with no key: the server handler adds it (decision 0046).
const NO_KEY: VerifyOptions = { handlerUrl: "https://handler.example.org/api/verify" };

// ---------------------------------------------------------------------------------------------

describe("constructor argument derivation (R-IN-3)", () => {
  it("derives the arguments of the recorded Sepolia deployment from RPC", async () => {
    const { fetch, seen } = fake({ rpc: RPC_GREETER });
    const result = await drive(verify(inputOf(GREETER), { ...WITH_KEY, fetch, rpcUrl: RPC_URL }));
    assert.equal(result.status, "verified");
    assert.equal(submittedArgs(seen), GREETER.constructorArgs.slice(2));
    assert.deepEqual(whats(seen), [
      "getsourcecode",
      "eth_chainId",
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
      "verifysourcecode",
      "checkverifystatus",
    ]);
  });

  it("derives the arguments from Etherscan getcontractcreation", async () => {
    const { fetch, seen } = fake({
      creation: etherscanFixture("2026-11-04-getcontractcreation-args-greeter"),
    });
    const result = await drive(verify(inputOf(GREETER), { ...WITH_KEY, fetch }));
    assert.equal(result.status, "verified");
    assert.equal(submittedArgs(seen), GREETER.constructorArgs.slice(2));
    const creation = seen.find((each) => each.what === "getcontractcreation");
    assert.equal(creation?.fields.get("contractaddresses"), GREETER.address);
    assert.equal(creation?.fields.get("apikey"), KEY);
  });

  it("derives a factory child's arguments from Etherscan when the transaction created the factory", async () => {
    const child = DEPLOYED.factoryChild;
    const { fetch, seen } = fake({
      rpc: {
        eth_chainId: rpcFixture("2026-11-04-eth-chainid-sepolia"),
        eth_getTransactionByHash: rpcFixture("2026-11-04-eth-gettransactionbyhash-args-factory"),
        eth_getTransactionReceipt: rpcFixture("2026-11-04-eth-gettransactionreceipt-args-factory"),
      },
      creation: etherscanFixture("2026-11-04-getcontractcreation-args-child"),
    });
    await drive(verify(inputOf(child), { ...WITH_KEY, fetch, rpcUrl: RPC_URL }));
    assert.equal(submittedArgs(seen), child.constructorArgs.slice(2));
    assert.ok(whats(seen).includes("getcontractcreation"));
  });

  it("derives a CREATE2 child's arguments from the deployer's input after its salt", async () => {
    const child = DEPLOYED.create2Child;
    const { fetch, seen } = fake({
      rpc: {
        eth_chainId: rpcFixture("2026-11-04-eth-chainid-sepolia"),
        eth_getTransactionByHash: rpcFixture("2026-11-04-eth-gettransactionbyhash-create2-child"),
      },
    });
    await drive(verify(inputOf(child), { ...NO_KEY, fetch, rpcUrl: RPC_URL }));
    assert.equal(submittedArgs(seen), child.constructorArgs.slice(2));
    // No receipt and no explorer: the deployer's input holds the init code.
    assert.ok(!whats(seen).includes("eth_getTransactionReceipt"));
    assert.ok(!whats(seen).includes("getcontractcreation"));
  });

  it("derives a CREATE2 child's arguments from Etherscan too, which gives the same encoding", async () => {
    const child = DEPLOYED.create2Child;
    const { fetch, seen } = fake({
      creation: etherscanFixture("2026-11-04-getcontractcreation-create2-child"),
    });
    await drive(verify(inputOf(child), { ...WITH_KEY, fetch }));
    assert.equal(submittedArgs(seen), child.constructorArgs.slice(2));
  });

  it("submits without arguments, factory-deployment at warn, when to is another contract and no explorer can be asked", async () => {
    const child = DEPLOYED.create2Child;
    const { fetch, seen } = fake({
      rpc: {
        eth_chainId: rpcFixture("2026-11-04-eth-chainid-sepolia"),
        eth_getTransactionByHash: edited(
          "rpc",
          "2026-11-04-eth-gettransactionbyhash-create2-child",
          '"to":"0x4e59b44847b379578588920ca78fbf26c0b4956c"',
          '"to":"0xe9daf98340a966703ab9e41be7d4b6b3687f79bc"',
        ),
      },
    });
    const line = await expectNoArgs(
      seen,
      (logger) => verify(inputOf(child), { ...NO_KEY, fetch, rpcUrl: RPC_URL, logger }),
      "factory-deployment",
    );
    assert.match(line, /names another transaction/);
    // No key bound: getcontractcreation is never sent.
    assert.ok(!whats(seen).includes("getcontractcreation"));
  });

  it("submits without arguments when the receipt names another contract and Etherscan has no record", async () => {
    const child = DEPLOYED.factoryChild;
    const { fetch, seen } = fake({
      rpc: {
        eth_chainId: rpcFixture("2026-11-04-eth-chainid-sepolia"),
        eth_getTransactionByHash: rpcFixture("2026-11-04-eth-gettransactionbyhash-args-factory"),
        eth_getTransactionReceipt: rpcFixture("2026-11-04-eth-gettransactionreceipt-args-factory"),
      },
      creation: etherscanFixture("2026-11-04-getcontractcreation-no-contract"),
    });
    await expectNoArgs(
      seen,
      (logger) => verify(inputOf(child), { ...WITH_KEY, fetch, rpcUrl: RPC_URL, logger }),
      "factory-deployment",
    );
  });

  it("submits without arguments when neither rpcUrl nor a key is set, and sends no derivation request (decision 0032)", async () => {
    const { fetch, seen } = fake({});
    await expectNoArgs(
      seen,
      (logger) => verify(inputOf(GREETER), { ...NO_KEY, fetch, logger }),
      "no-source",
      "info",
    );
    assert.deepEqual(whats(seen), ["getsourcecode", "verifysourcecode", "checkverifystatus"]);
  });

  it("submits without arguments when Etherscan cannot answer getcontractcreation (decision 0032)", async () => {
    const { fetch, seen } = fake({ creation: json({ error: "busy" }, 503) });
    await expectNoArgs(seen, (logger) => verify(inputOf(GREETER), { ...WITH_KEY, fetch, logger }));
  });

  it("submits without arguments when the RPC and Etherscan both fail for a direct deployment (decision 0032)", async () => {
    const { fetch, seen } = fake({
      rpc: { eth_chainId: json({ error: "down" }, 503) },
      creation: new Error("socket hang up"),
    });
    await expectNoArgs(seen, (logger) =>
      verify(inputOf(GREETER), { ...WITH_KEY, fetch, rpcUrl: RPC_URL, logger }),
    );
  });

  it("submits without arguments for a factory child when Etherscan cannot answer (decision 0032)", async () => {
    const child = DEPLOYED.factoryChild;
    const { fetch, seen } = fake({
      rpc: {
        eth_chainId: rpcFixture("2026-11-04-eth-chainid-sepolia"),
        eth_getTransactionByHash: rpcFixture("2026-11-04-eth-gettransactionbyhash-args-factory"),
        eth_getTransactionReceipt: rpcFixture("2026-11-04-eth-gettransactionreceipt-args-factory"),
      },
      creation: new Error("socket hang up"),
    });
    await expectNoArgs(
      seen,
      (logger) => verify(inputOf(child), { ...WITH_KEY, fetch, rpcUrl: RPC_URL, logger }),
      "factory-deployment",
    );
  });

  it("treats a transaction without a to field as a creation and checks its receipt", async () => {
    const { fetch, seen } = fake({
      rpc: {
        ...RPC_GREETER,
        eth_getTransactionByHash: edited(
          "rpc",
          "2026-11-04-eth-gettransactionbyhash-args-greeter",
          '"to":null,',
          "",
        ),
      },
    });
    await drive(verify(inputOf(GREETER), { ...NO_KEY, fetch, rpcUrl: RPC_URL }));
    assert.equal(submittedArgs(seen), GREETER.constructorArgs.slice(2));
    assert.ok(whats(seen).includes("eth_getTransactionReceipt"));
  });

  it("treats an eth_chainId result that is not a hex quantity as no usable answer", async () => {
    const { fetch, seen } = fake({
      rpc: { eth_chainId: json({ jsonrpc: "2.0", id: 1, result: "sepolia" }) },
      creation: etherscanFixture("2026-11-04-getcontractcreation-args-greeter"),
    });
    await drive(verify(inputOf(GREETER), { ...WITH_KEY, fetch, rpcUrl: RPC_URL }));
    assert.equal(submittedArgs(seen), GREETER.constructorArgs.slice(2));
    assert.ok(!whats(seen).includes("eth_getTransactionByHash"));
  });

  it("throws the timeout when the budget runs out during getcontractcreation", async () => {
    const { fetch } = fake({ creation: "hang" });
    const error = await errorOf(verify(inputOf(GREETER), { ...WITH_KEY, fetch, timeoutMs: 5_000 }));
    assert.equal(error.code, "timeout");
  });

  it("submits without arguments when Etherscan has no record for the address (decision 0032)", async () => {
    const { fetch, seen } = fake({
      creation: etherscanFixture("2026-11-04-getcontractcreation-no-contract"),
    });
    await expectNoArgs(seen, (logger) => verify(inputOf(GREETER), { ...WITH_KEY, fetch, logger }));
  });

  it("uses only the Etherscan record whose contractAddress is the contract", async () => {
    const { fetch, seen } = fake({
      creation: edited(
        "etherscan",
        "2026-11-04-getcontractcreation-args-greeter",
        `"contractAddress":"${GREETER.address}"`,
        `"contractAddress":"${DEPLOYED.factoryChild.address}"`,
      ),
    });
    await expectNoArgs(seen, (logger) => verify(inputOf(GREETER), { ...WITH_KEY, fetch, logger }));
  });

  it("treats a record without creationBytecode as no creation code", async () => {
    const { fetch, seen } = fake({
      creation: edited(
        "etherscan",
        "2026-11-04-getcontractcreation-args-greeter",
        `"creationBytecode":"0x`,
        `"creationBytecode":"not hex`,
      ),
    });
    await expectNoArgs(seen, (logger) => verify(inputOf(GREETER), { ...WITH_KEY, fetch, logger }));
  });

  it("submits without arguments after a getcontractcreation answer it does not recognise (decision 0032)", async () => {
    const { fetch, seen } = fake({
      creation: json({ status: "0", message: "NOTOK", result: "Something new" }),
    });
    await expectNoArgs(seen, (logger) => verify(inputOf(GREETER), { ...WITH_KEY, fetch, logger }));
  });

  it("throws the key error Etherscan gives to getcontractcreation", async () => {
    const { fetch } = fake({
      creation: json({ status: "0", message: "NOTOK", result: "Invalid API Key (#err2)|1" }),
    });
    const error = await errorOf(verify(inputOf(GREETER), { ...WITH_KEY, fetch }));
    assert.equal(error.code, "api-key-rejected");
  });

  it("masks library placeholders when matching", async () => {
    // A synthetic placeholder over 20 bytes of the compiled bytecode: those bytes may differ.
    const code = GREETER.creationBytecode;
    const placeholder = `__$${"1f".repeat(17)}$__`;
    const masked: Hex = `0x${code.slice(2, 102)}${placeholder}${code.slice(142)}`;
    assert.equal(masked.length, code.length);
    const { fetch, seen } = fake({ rpc: RPC_GREETER });
    await drive(
      verify(inputOf(GREETER, { creationBytecode: masked }), {
        ...WITH_KEY,
        fetch,
        rpcUrl: RPC_URL,
      }),
    );
    assert.equal(submittedArgs(seen), GREETER.constructorArgs.slice(2));
  });

  it("still compares the bytes outside a placeholder", async () => {
    const code = GREETER.creationBytecode;
    const placeholder = `__$${"1f".repeat(17)}$__`;
    // One byte after the placeholder changed.
    const changed: Hex = `0x${code.slice(2, 102)}${placeholder}${code.slice(142, 150)}ff${code.slice(152)}`;
    assert.notEqual(code.slice(150, 152), "ff");
    const { fetch } = fake({ rpc: RPC_GREETER });
    const error = await errorOf(
      verify(inputOf(GREETER, { creationBytecode: changed }), {
        ...WITH_KEY,
        fetch,
        rpcUrl: RPC_URL,
      }),
    );
    assert.equal(
      error.details.code === "constructor-args-unavailable" && error.details.reason,
      "prefix-mismatch",
    );
  });

  it("returns no arguments for an empty remainder", async () => {
    const whole: Hex = `${GREETER.creationBytecode}${GREETER.constructorArgs.slice(2)}`;
    const { fetch, seen } = fake({ rpc: RPC_GREETER });
    const result = await drive(
      verify(inputOf(GREETER, { creationBytecode: whole }), {
        ...WITH_KEY,
        fetch,
        rpcUrl: RPC_URL,
      }),
    );
    assert.equal(result.status, "verified");
    assert.equal(submittedArgs(seen), undefined);
  });

  it("throws prefix-mismatch when one source comment differs", async () => {
    const editedComment = DEPLOYED.greeterEditedComment.creationBytecode;
    assert.notEqual(editedComment, GREETER.creationBytecode);
    const { fetch, seen } = fake({ rpc: RPC_GREETER });
    const error = await errorOf(
      verify(inputOf(GREETER, { creationBytecode: editedComment }), {
        ...WITH_KEY,
        fetch,
        rpcUrl: RPC_URL,
      }),
    );
    assert.deepEqual(error.details, {
      code: "constructor-args-unavailable",
      reason: "prefix-mismatch",
    });
    assert.match(error.message, /differs from the deployed build/);
    assert.match(error.hint, /check creationBytecode against the deployed build/);
    assert.equal(ERROR_EXIT_CODES[error.code], 2);
    assert.equal(error.retryable, false);
    assert.ok(!whats(seen).includes("verifysourcecode"));
  });

  it("throws prefix-mismatch when the creation code is shorter than creationBytecode", async () => {
    const longer: Hex = `${GREETER.creationBytecode}${GREETER.constructorArgs.slice(2)}00`;
    const { fetch } = fake({ rpc: RPC_GREETER });
    const error = await errorOf(
      verify(inputOf(GREETER, { creationBytecode: longer }), {
        ...WITH_KEY,
        fetch,
        rpcUrl: RPC_URL,
      }),
    );
    assert.equal(
      error.details.code === "constructor-args-unavailable" && error.details.reason,
      "prefix-mismatch",
    );
  });

  it("throws prefix-mismatch when a trailing placeholder runs past the creation code", async () => {
    const placeholder = `__$${"1f".repeat(17)}$__`;
    const past: Hex = `${GREETER.creationBytecode}${GREETER.constructorArgs.slice(2)}${placeholder}`;
    const { fetch } = fake({ rpc: RPC_GREETER });
    const error = await errorOf(
      verify(inputOf(GREETER, { creationBytecode: past }), {
        ...WITH_KEY,
        fetch,
        rpcUrl: RPC_URL,
      }),
    );
    assert.deepEqual(error.details, {
      code: "constructor-args-unavailable",
      reason: "prefix-mismatch",
    });
  });

  it("throws bad-length for a remainder that is not whole words", async () => {
    // One byte of the arguments moved into the prefix: 31 bytes are left over in the last word.
    const plusOne: Hex = `${GREETER.creationBytecode}${GREETER.constructorArgs.slice(2, 4)}`;
    const { fetch } = fake({ rpc: RPC_GREETER });
    const error = await errorOf(
      verify(inputOf(GREETER, { creationBytecode: plusOne }), {
        ...WITH_KEY,
        fetch,
        rpcUrl: RPC_URL,
      }),
    );
    assert.deepEqual(error.details, { code: "constructor-args-unavailable", reason: "bad-length" });
  });

  it("caller constructorArgs skip derivation and make no request", async () => {
    const { fetch, seen } = fake({});
    await drive(
      verify(inputOf(GREETER, { constructorArgs: "0x1234" }), {
        ...WITH_KEY,
        fetch,
        rpcUrl: RPC_URL,
      }),
    );
    assert.equal(submittedArgs(seen), "1234");
    assert.deepEqual(whats(seen), ["getsourcecode", "verifysourcecode", "checkverifystatus"]);
  });

  it("caller constructorArgs of 0x win too: no derivation and no arguments sent", async () => {
    const { fetch, seen } = fake({});
    await drive(
      verify(inputOf(GREETER, { constructorArgs: "0x" }), { ...WITH_KEY, fetch, rpcUrl: RPC_URL }),
    );
    assert.equal(submittedArgs(seen), undefined);
    assert.deepEqual(whats(seen), ["getsourcecode", "verifysourcecode", "checkverifystatus"]);
  });

  it("does not derive without creationBytecode", async () => {
    const { creationBytecode: _unused, ...input } = inputOf(GREETER);
    assert.ok(_unused !== undefined);
    const { fetch, seen } = fake({});
    await drive(verify(input, { ...WITH_KEY, fetch, rpcUrl: RPC_URL }));
    assert.equal(submittedArgs(seen), undefined);
  });

  it("does not derive when the contract is already verified", async () => {
    const { fetch, seen } = fake({});
    const already: typeof fetch = async (input, init) => {
      const body = init?.body;
      if (body instanceof URLSearchParams && body.get("action") === "getsourcecode") {
        return json({
          status: "1",
          message: "OK",
          result: [{ SourceCode: "{}", ABI: "[]", SimilarMatch: "" }],
        });
      }
      return await fetch(input, init);
    };
    const result = await drive(
      verify(inputOf(GREETER), { ...WITH_KEY, fetch: already, rpcUrl: RPC_URL }),
    );
    assert.equal(result.status, "already-verified");
    assert.deepEqual(whats(seen), []);
  });

  it("does not derive on a Sourcify route, which takes no arguments", async () => {
    const requests: string[] = [];
    const sourcifyFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      return json({ match: "exact_match" });
    };
    await drive(
      verify(inputOf(GREETER), {
        route: { backend: "sourcify" },
        fetch: sourcifyFetch,
        rpcUrl: RPC_URL,
      }),
    ).catch(() => undefined);
    assert.ok(requests.length > 0);
    assert.ok(requests.every((url) => !url.includes("rpc.example.org")));
  });

  it("falls back to Etherscan when the JSON-RPC endpoint fails", async () => {
    const { fetch, seen } = fake({
      rpc: { eth_chainId: json({ error: "down" }, 503) },
      creation: etherscanFixture("2026-11-04-getcontractcreation-args-greeter"),
    });
    const lines: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: (message) => lines.push(message),
      warn: (message) => lines.push(message),
      error: (message) => lines.push(message),
    };
    await drive(verify(inputOf(GREETER), { ...WITH_KEY, fetch, rpcUrl: RPC_URL, logger }));
    assert.equal(submittedArgs(seen), GREETER.constructorArgs.slice(2));
    assert.ok(!whats(seen).includes("eth_getTransactionByHash"));
    assert.ok(lines.some((line) => line.startsWith("Derived the constructor arguments")));
  });

  it("logs JSON-RPC retries with label rpc, no backend name, no verify.retry and no key (#134, R-DX-5, R-SEC-1)", async () => {
    const { fetch, seen } = fake({
      rpc: { eth_chainId: json({ error: `busy at ${RPC_URL}` }, 503) },
      creation: etherscanFixture("2026-11-04-getcontractcreation-args-greeter"),
    });
    const lines: { level: string; message: string; fields: LogFields }[] = [];
    const record =
      (level: string) =>
      (message: string, fields?: LogFields): void => {
        lines.push({ level, message, fields: fields ?? {} });
      };
    const logger: Logger = {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    };
    const events: VerifyEvent[] = [];
    await drive(
      verify(inputOf(GREETER), {
        ...WITH_KEY,
        fetch,
        rpcUrl: RPC_URL,
        logger,
        onEvent: (event) => {
          events.push(event);
        },
      }),
    );
    assert.equal(whats(seen).filter((what) => what === "eth_chainId").length, 5);
    const rpcLines = lines.filter((line) => line.fields["label"] === "rpc");
    assert.equal(rpcLines.filter((line) => line.level === "warn").length, 4);
    assert.equal(rpcLines.filter((line) => line.level === "debug").length, 5);
    assert.ok(rpcLines.every((line) => !("backend" in line.fields)));
    assert.ok(
      rpcLines.every((line) => line.fields["url"] === "https://rpc.example.org/v2/[redacted]"),
    );
    assert.deepEqual(
      events.filter((event) => event.type === "verify.retry"),
      [],
    );
    const text = JSON.stringify([lines, events]);
    assert.ok(!text.includes(RPC_SECRET), text);
    assert.ok(!text.includes(KEY), text);
    assert.equal(submittedArgs(seen), GREETER.constructorArgs.slice(2));
  });

  it("falls back when the transaction is not found", async () => {
    const { fetch, seen } = fake({
      rpc: {
        eth_chainId: rpcFixture("2026-11-04-eth-chainid-sepolia"),
        eth_getTransactionByHash: rpcFixture("2026-11-04-eth-gettransactionbyhash-unknown"),
      },
      creation: etherscanFixture("2026-11-04-getcontractcreation-args-greeter"),
    });
    await drive(verify(inputOf(GREETER), { ...WITH_KEY, fetch, rpcUrl: RPC_URL }));
    assert.equal(submittedArgs(seen), GREETER.constructorArgs.slice(2));
  });

  it("falls back when the receipt has no contract address", async () => {
    const { fetch, seen } = fake({
      rpc: {
        eth_chainId: rpcFixture("2026-11-04-eth-chainid-sepolia"),
        eth_getTransactionByHash: rpcFixture("2026-11-04-eth-gettransactionbyhash-args-greeter"),
        eth_getTransactionReceipt: json({ jsonrpc: "2.0", id: 1, result: null }),
      },
    });
    await expectNoArgs(seen, (logger) =>
      verify(inputOf(GREETER), { ...NO_KEY, fetch, rpcUrl: RPC_URL, logger }),
    );
  });

  it("does not use a transaction input that is not hex", async () => {
    const { fetch, seen } = fake({
      rpc: {
        eth_chainId: rpcFixture("2026-11-04-eth-chainid-sepolia"),
        eth_getTransactionByHash: edited(
          "rpc",
          "2026-11-04-eth-gettransactionbyhash-args-greeter",
          `"input":"0x`,
          `"input":"zz`,
        ),
      },
    });
    await expectNoArgs(seen, (logger) =>
      verify(inputOf(GREETER), { ...NO_KEY, fetch, rpcUrl: RPC_URL, logger }),
    );
  });

  it("does not ask rpcUrl without creationTxHash", async () => {
    const { creationTxHash: _unused, ...input } = inputOf(GREETER);
    assert.ok(_unused !== undefined);
    const { fetch, seen } = fake({
      creation: etherscanFixture("2026-11-04-getcontractcreation-args-greeter"),
    });
    await drive(verify(input, { ...WITH_KEY, fetch, rpcUrl: RPC_URL }));
    assert.ok(seen.every((each) => each.host !== "rpc.example.org"));
    assert.equal(submittedArgs(seen), GREETER.constructorArgs.slice(2));
  });

  it("throws invalid-input naming rpcUrl when it serves another chain", async () => {
    const { fetch, seen } = fake({
      rpc: { eth_chainId: json({ jsonrpc: "2.0", id: 1, result: "0x1" }) },
    });
    const error = await errorOf(verify(inputOf(GREETER), { ...WITH_KEY, fetch, rpcUrl: RPC_URL }));
    assert.equal(error.code, "invalid-input");
    assert.deepEqual(
      error.details.code === "invalid-input" && error.details.issues.map((issue) => issue.field),
      ["rpcUrl"],
    );
    assert.ok(!whats(seen).includes("verifysourcecode"));
  });

  it("throws timeout when the budget runs out during a JSON-RPC request", async () => {
    const { fetch } = fake({ rpc: { eth_chainId: "hang" } });
    const error = await errorOf(
      verify(inputOf(GREETER), { ...WITH_KEY, fetch, rpcUrl: RPC_URL, timeoutMs: 5_000 }),
    );
    assert.equal(error.code, "timeout");
    assert.match(error.message, /rpcUrl \(eth_chainId\)/);
  });

  it("rejects with the signal's reason when aborted during a JSON-RPC request", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const { fetch, seen } = fake({ rpc: { eth_chainId: "hang" } });
    const pending = verify(inputOf(GREETER), {
      ...WITH_KEY,
      fetch,
      rpcUrl: RPC_URL,
      signal: controller.signal,
    });
    // Abort once the JSON-RPC request is in flight, however long the client load took.
    await turnUntil(() => whats(seen).includes("eth_chainId"));
    controller.abort(reason);
    await assert.rejects(drive(pending), (error) => error === reason);
  });

  it("an rpcUrl with a key in its path never reaches a log, event or error (R-SEC-1)", async () => {
    const lines: string[] = [];
    const record =
      (level: string) =>
      (message: string, fields?: LogFields): void => {
        lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
      };
    const logger: Logger = {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    };
    const events: VerifyEvent[] = [];
    const onEvent = (event: VerifyEvent): void => {
      events.push(event);
    };
    // First run: the endpoint repeats the URL in a failed answer, and the call submits without
    // arguments (decision 0032).
    const failing = fake({
      rpc: { eth_chainId: json({ error: `bad request to ${RPC_URL}` }, 500) },
    });
    const result = await drive(
      verify(inputOf(GREETER), {
        ...NO_KEY,
        fetch: failing.fetch,
        rpcUrl: RPC_URL,
        logger,
        onEvent,
      }),
    );
    // Second run: a build that differs from the deployed one throws on Etherscan.
    const mismatched = fake({ rpc: RPC_GREETER });
    const error = await errorOf(
      verify(
        inputOf(GREETER, { creationBytecode: DEPLOYED.greeterEditedComment.creationBytecode }),
        {
          ...NO_KEY,
          fetch: mismatched.fetch,
          rpcUrl: RPC_URL,
          logger,
          onEvent,
        },
      ),
    );
    assert.equal(error.code, "constructor-args-unavailable");
    const surfaces = [
      ...lines,
      JSON.stringify(events),
      JSON.stringify(result),
      error.message,
      error.hint,
      JSON.stringify(error),
      JSON.stringify(error.toJSON()),
      inspect(error, { depth: 10 }),
    ];
    for (const surface of surfaces) {
      assert.ok(!surface.includes(RPC_SECRET), surface);
    }
    assert.ok(lines.length > 0);
  });

  it("an invalid rpcUrl throws invalid-input naming rpcUrl, without the value", async () => {
    const { fetch, seen } = fake({});
    const bad = `http://rpc.example.org/v2/${RPC_SECRET}`;
    const error = await errorOf(verify(inputOf(GREETER), { ...WITH_KEY, fetch, rpcUrl: bad }));
    assert.equal(error.code, "invalid-input");
    assert.deepEqual(
      error.details.code === "invalid-input" && error.details.issues.map((issue) => issue.field),
      ["rpcUrl"],
    );
    assert.ok(!JSON.stringify(error).includes(RPC_SECRET));
    assert.ok(!error.message.includes(RPC_SECRET));
    assert.deepEqual(seen, []);
  });

  it("redacts a key in an rpcUrl query value and its decoded form", async () => {
    const encoded = "abc%2Fdef0123456789";
    const lines: string[] = [];
    const logger: Logger = {
      debug: (message, fields) => lines.push(message + JSON.stringify(fields ?? {})),
      info: (message, fields) => lines.push(message + JSON.stringify(fields ?? {})),
      warn: (message, fields) => lines.push(message + JSON.stringify(fields ?? {})),
      error: (message, fields) => lines.push(message + JSON.stringify(fields ?? {})),
    };
    const { fetch } = fake({ rpc: { eth_chainId: json({ error: "abc/def0123456789" }, 400) } });
    const result = await drive(
      verify(inputOf(GREETER), {
        ...NO_KEY,
        fetch,
        rpcUrl: `https://rpc.example.org/?key=${encoded}`,
        logger,
      }),
    );
    assert.equal(result.status, "verified");
    assert.ok(lines.some((line) => line.includes("no-creation-code")));
    for (const surface of [...lines, JSON.stringify(result)]) {
      assert.ok(!surface.includes("abc/def0123456789"), surface);
    }
  });
});

/** A build-info with ArgsChild.sol and `evm.bytecode.object` for each named contract. */
function buildInfo(objects: Readonly<Record<string, string>>): unknown {
  return {
    id: "b1",
    solcLongVersion: VERSION,
    input: {
      language: "Solidity",
      sources: { "src/ArgsChild.sol": { content: DEPLOYED.sources["src/ArgsChild.sol"] } },
      settings: {},
    },
    output: {
      contracts: {
        "src/ArgsChild.sol": Object.fromEntries(
          Object.entries(objects).map(([name, object]) => [
            name,
            { abi: [], evm: { bytecode: { object } } },
          ]),
        ),
      },
    },
  };
}
/** A Blockscout-like client that records the submitted input and reports it verified. */
function recordingBlockscout(submitted: VerifyInput[]): Backend {
  return {
    name: "blockscout",
    takesConstructorArgs: true,
    lookup: async () => await Promise.resolve(undefined),
    submit: async (input) => {
      submitted.push(input);
      return await Promise.resolve({ state: "already-verified", match: "partial" });
    },
    poll: async () => await Promise.resolve({ state: "pending" }),
    explorerUrl: () => undefined,
  };
}

describe("a mismatch on a backend that reports partial matches (decision 0032)", () => {
  const ROUTE = { backend: "blockscout", apiUrl: "https://blockscout.example.org/api" } as const;

  for (const [reason, creationBytecode] of [
    ["prefix-mismatch", DEPLOYED.greeterEditedComment.creationBytecode],
    ["bad-length", `${GREETER.creationBytecode}${GREETER.constructorArgs.slice(2, 4)}`],
  ] as const) {
    it(`submits without arguments on Blockscout after ${reason}, logged at warn`, async () => {
      const submitted: VerifyInput[] = [];
      const { fetch } = fake({ rpc: RPC_GREETER });
      const lines: string[] = [];
      const logger: Logger = {
        debug: () => {},
        info: () => {},
        warn: (message, fields) => lines.push(`${message} ${JSON.stringify(fields ?? {})}`),
        error: () => {},
      };
      const result = await drive(
        runVerify(
          inputOf(GREETER, { creationBytecode: hexOf(creationBytecode) }),
          { route: ROUTE, fetch, rpcUrl: RPC_URL, logger },
          { backends: { blockscout: recordingBlockscout(submitted) } },
        ),
      );
      assert.equal(result.status, "already-verified");
      assert.equal(submitted.length, 1);
      assert.equal(submitted[0]?.constructorArgs, undefined);
      assert.ok(
        lines.some((line) => line.includes(`"reason":"${reason}"`)),
        lines.join("\n"),
      );
    });
  }

  it("derives the arguments for Blockscout from RPC", async () => {
    const submitted: VerifyInput[] = [];
    const { fetch } = fake({ rpc: RPC_GREETER });
    await drive(
      runVerify(
        inputOf(GREETER),
        { route: ROUTE, fetch, rpcUrl: RPC_URL },
        { backends: { blockscout: recordingBlockscout(submitted) }, random: () => 0 },
      ),
    );
    assert.equal(submitted[0]?.constructorArgs, GREETER.constructorArgs);
  });

  it("withDerivedArgs works with an HTTP context that has no budget, fetch, signal or jitter", async () => {
    const lines: string[] = [];
    const observer = createObserver({
      logger: {
        debug: () => {},
        info: (message) => lines.push(message),
        warn: (message) => lines.push(message),
        error: () => {},
      },
      secrets: [],
    });
    const input = inputOf(GREETER);
    const result = await withDerivedArgs(
      {
        backend: recordingBlockscout([]),
        ctx: { route: resolveRoute(CHAIN_ID, ROUTE), http: { backend: "blockscout", secrets: [] } },
        settings: { rpcUrl: undefined },
        observer,
        target: { chainId: CHAIN_ID, address: GREETER.address },
      },
      input,
      GREETER.creationBytecode,
    );
    assert.equal(result, input);
    assert.ok(
      lines.some((line) => line.includes("(no-source)")),
      lines.join("\n"),
    );
  });

  it("marks the Etherscan v2, Etherscan-compatible and Routescan clients as refusing another build, and not Blockscout", () => {
    assert.equal(etherscan.refusesOtherBuilds, true);
    assert.equal(routescan.refusesOtherBuilds, true);
    assert.equal(etherscanCompatible.refusesOtherBuilds, true);
    assert.equal(etherscanCompatible.takesConstructorArgs, true);
    // Only Etherscan v2 reads the creation code: no other explorer's record was checked live.
    assert.equal(etherscanCompatible.creationCode, undefined);
    assert.equal(routescan.creationCode, undefined);
    assert.equal(blockscout.refusesOtherBuilds, undefined);
    assert.equal(blockscout.takesConstructorArgs, true);
  });
});

describe("creationBytecode in validateInput and buildVerifyInput (R-IN-1, R-IN-7)", () => {
  const base = inputOf(GREETER);

  it("accepts library placeholders, adds 0x and lowers the case", () => {
    const placeholder = `__$${"ab".repeat(17)}$__`;
    const checked = validateInput({ ...base, creationBytecode: `6080AB${placeholder}00` });
    assert.equal(checked.creationBytecode, `0x6080ab${placeholder}00`);
  });

  it("rejects odd hex, other characters, null and an oversized value, naming the field", () => {
    for (const value of [
      "",
      "0x",
      "0x123",
      "0xzz",
      null,
      `0x${"00".repeat(65_537)}`,
      "__Tally_____________________________",
    ]) {
      assert.throws(
        () => validateInput({ ...base, creationBytecode: value }),
        (error) =>
          error instanceof ExplorerVerifyError &&
          error.details.code === "invalid-input" &&
          error.details.issues.some((issue) => issue.field === "creationBytecode"),
      );
    }
  });

  it("accepts 65536 bytes", () => {
    const checked = validateInput({ ...base, creationBytecode: `0x${"00".repeat(65_536)}` });
    assert.equal(checked.creationBytecode?.length, 2 + 131_072);
  });

  it("fills creationBytecode from a build-info output", () => {
    const object = DEPLOYED.factoryChild.creationBytecode.slice(2);
    const built = buildVerifyInput([buildInfo({ ArgsChild: object })]);
    assert.equal(built.creationBytecode, `0x${object}`);
  });

  it("fills creationBytecode from a Hardhat artifact's bytecode next to its build-info", () => {
    const artifact = {
      contractName: "ArgsChild",
      sourceName: "src/ArgsChild.sol",
      abi: [],
      bytecode: DEPLOYED.factoryChild.creationBytecode,
      buildInfoId: "b1",
    };
    const built = buildVerifyInput([buildInfo({}), artifact]);
    assert.equal(built.creationBytecode, DEPLOYED.factoryChild.creationBytecode);
  });

  it("fills creationBytecode from the Foundry fixture artifact's bytecode.object", () => {
    const dir = new URL("../fixtures/build-formats/foundry-1.8.1/", import.meta.url);
    const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
    const artifact = read("Greeter.json");
    const built = buildVerifyInput([read("build-info.json"), artifact]);
    const expected = JSON.stringify(artifact).match(/"bytecode":\{"object":"(0x[0-9a-f]+)"/)?.[1];
    assert.ok(expected !== undefined);
    assert.equal(built.creationBytecode, expected);
  });

  it("leaves creationBytecode out when two documents disagree, or none holds it", () => {
    const object = DEPLOYED.factoryChild.creationBytecode;
    const artifact = {
      contractName: "ArgsChild",
      sourceName: "src/ArgsChild.sol",
      abi: [],
      bytecode: `${object}00`,
      buildInfoId: "b1",
    };
    assert.equal(
      buildVerifyInput([buildInfo({ ArgsChild: object }), artifact]).creationBytecode,
      undefined,
    );
    assert.equal(
      buildVerifyInput([buildInfo({})], { contract: "src/ArgsChild.sol:ArgsChild" })
        .creationBytecode,
      undefined,
    );
    assert.equal(buildVerifyInput([buildInfo({ ArgsChild: "" })]).creationBytecode, undefined);
    assert.equal(
      buildVerifyInput([buildInfo({ ArgsChild: "__Old___" })]).creationBytecode,
      undefined,
    );
  });

  it("takes the chosen contract's bytecode, not another one's", () => {
    const object = DEPLOYED.factoryChild.creationBytecode.slice(2);
    const built = buildVerifyInput([buildInfo({ ArgsChild: object, Other: "6000" })], {
      contract: "src/ArgsChild.sol:ArgsChild",
    });
    assert.equal(built.creationBytecode, `0x${object}`);
  });
});
