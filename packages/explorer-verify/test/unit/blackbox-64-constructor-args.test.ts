// Black-box tests for issue #64: deriving constructor arguments from the creation code (R-IN-3,
// decision 0032). They use only the issue, docs/user/reference/verify.md (Constructor arguments,
// the rpcUrl option), the constructor-args-unavailable error page, api-keys.md, requirements.md
// R-IN-3, decision 0032, the TSDoc of VerifyInput.creationBytecode and VerifyOptions.rpcUrl, and
// the package entry point. Every call goes through `verify()` (or `buildVerifyInput`) with a fake
// `fetch` that answers JSON-RPC, Etherscan, Sourcify and Blockscout. Keys and the RPC URL are
// dummies. Time runs on node:test mock timers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { inspect } from "node:util";

import { ERROR_EXIT_CODES } from "../../src/envelope.ts";
import { ExplorerVerifyError, buildVerifyInput, verify } from "../../src/index.ts";
import type {
  Hex,
  LogFields,
  Logger,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../../src/index.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

// ---------------------------------------------------------------------------------------------
// Fixtures.

const FIXTURES = new URL("../fixtures/", import.meta.url);

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8"));
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      throw new Error(`fixture has no ${path.join(".")}`);
    }
    current = Reflect.get(current, key);
  }
  return current;
}

function text(value: unknown, ...path: string[]): string {
  const found = field(value, ...path);
  if (typeof found !== "string") {
    throw new Error(`fixture ${path.join(".")} is not a string`);
  }
  return found;
}

function hex(value: string): Hex {
  if (!value.startsWith("0x")) {
    throw new Error("not hex");
  }
  return `0x${value.slice(2)}`;
}

const DEPLOY = fixture("constructor-args/2026-11-04-sepolia-deployments.json");
const GREETER = {
  address: hex(text(DEPLOY, "greeter", "address")),
  txHash: hex(text(DEPLOY, "greeter", "creationTxHash")),
  args: hex(text(DEPLOY, "greeter", "constructorArgs")),
  bytecode: hex(text(DEPLOY, "greeter", "creationBytecode")),
};
const EDITED_BYTECODE = hex(text(DEPLOY, "greeterEditedComment", "creationBytecode"));
const CHILD = {
  address: hex(text(DEPLOY, "factoryChild", "address")),
  txHash: hex(text(DEPLOY, "factoryChild", "creationTxHash")),
  args: hex(text(DEPLOY, "factoryChild", "constructorArgs")),
  bytecode: hex(text(DEPLOY, "factoryChild", "creationBytecode")),
};
const CREATE2 = {
  address: hex(text(DEPLOY, "create2Child", "address")),
  txHash: hex(text(DEPLOY, "create2Child", "creationTxHash")),
  args: hex(text(DEPLOY, "create2Child", "constructorArgs")),
  bytecode: hex(text(DEPLOY, "create2Child", "creationBytecode")),
};

const rpcResult = (name: string): unknown =>
  field(fixture(`rpc/${name}`), "response", "body", "result");
const etherscanBody = (name: string): unknown =>
  field(fixture(`etherscan/${name}`), "response", "body");

const TX_GREETER = rpcResult("2026-11-04-eth-gettransactionbyhash-args-greeter.json");
const RECEIPT_GREETER = rpcResult("2026-11-04-eth-gettransactionreceipt-args-greeter.json");
const TX_FACTORY = rpcResult("2026-11-04-eth-gettransactionbyhash-args-factory.json");
const RECEIPT_FACTORY = rpcResult("2026-11-04-eth-gettransactionreceipt-args-factory.json");
const TX_CREATE2 = rpcResult("2026-11-04-eth-gettransactionbyhash-create2-child.json");
const GREETER_INPUT = hex(text(TX_GREETER, "input"));

const CREATION_CHILD = etherscanBody("2026-11-04-getcontractcreation-args-child.json");
const CREATION_CREATE2 = etherscanBody("2026-11-04-getcontractcreation-create2-child.json");
const CREATION_GREETER = etherscanBody("2026-11-04-getcontractcreation-args-greeter.json");
const CREATION_NONE = etherscanBody("2026-11-04-getcontractcreation-no-contract.json");

// ---------------------------------------------------------------------------------------------
// Dummy secrets. Lower case and free of key-like parameter names, so only the library's knowledge
// of them can remove them.

const KEY = "zz9dummyetherscankeyqq7xv";
const RPC_SECRET = "rpcpathsecretq7w3zk9";
const RPC_QUERY_SECRET = "rpcquerysecretm4n8p2";
const RPC_HOST = "rpc.example.org";
// A server handler that adds the Etherscan key: the keyless Etherscan case (decision 0046).
const HANDLER_HOST = "handler.example.org";
const HANDLER_URL = `https://${HANDLER_HOST}/api/verify`;
const RPC_URL = `https://${RPC_HOST}/v3/${RPC_SECRET}`;
const RPC_URL_QUERY = `https://${RPC_HOST}/rpc?project=${RPC_QUERY_SECRET}`;
const SECRETS = [KEY, RPC_SECRET, RPC_QUERY_SECRET];

const CHAIN_ID = 11155111;
const CHAIN_HEX = "0xaa36a7";
const ETHERSCAN_API = "https://api.etherscan.io/v2/api";
const BLOCKSCOUT_API = "https://eth-sepolia.blockscout.com/api";
const GUID = "yatwfd5yijmxufgkexd8ygesyexubjazunjnbgkemvwbm7vhrw";
const VERSION = "0.8.24+commit.e11b9ed9";

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

/** Calls `verify()` with values the types do not allow, as JSON from a file would give. */
async function verifyLoose(input: unknown, options: unknown): Promise<unknown> {
  const pending: unknown = Reflect.apply(verify, undefined, [input, options]);
  if (!(pending instanceof Promise)) {
    throw new Error("verify did not return a promise");
  }
  const result: unknown = await pending;
  return result;
}

async function errorOfLoose(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
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
// One fake for every host.

type Step = { readonly http?: number; readonly body: unknown } | "network" | "hang";

type RpcScript = Partial<Record<string, Step | ((params: unknown) => Step)>>;
type EtherscanAction =
  | "getsourcecode"
  | "verifysourcecode"
  | "checkverifystatus"
  | "getcontractcreation";
type EtherscanScript = Partial<Record<EtherscanAction, Step>>;

interface Call {
  readonly host: string;
  readonly url: string;
  readonly method: string;
  readonly redirect: RequestRedirect | undefined;
  readonly body: string;
  readonly headers: [string, string][];
  /** The JSON-RPC method, or the Etherscan-style action, or the Sourcify/Blockscout path. */
  readonly what: string;
}

const ok = (result: unknown): Step => ({
  body: { status: "1", message: "OK", result },
});
const notok = (result: unknown, message = "NOTOK"): Step => ({
  body: { status: "0", message, result },
});
const LOOKUP_NONE = ok([
  {
    SourceCode: "",
    ABI: "Contract source code not verified",
    ContractName: "",
    CompilerVersion: "",
  },
]);
const LOOKUP_EXACT = ok([
  {
    SourceCode: '{{"language":"Solidity","sources":{}}}',
    ABI: "[]",
    ContractName: "ArgsGreeter",
    CompilerVersion: `v${VERSION}`,
    SimilarMatch: "",
  },
]);
const PASS = ok("Pass - Verified");
const SUBMIT_OK = ok(GUID);

function bodyText(body: BodyInit | null | undefined): string {
  if (body === undefined || body === null) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return inspect(body);
}

function rpcId(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && "id" in parsed ? parsed.id : 1;
  } catch {
    return 1;
  }
}

function rpcMethod(raw: string): { method: string; params: unknown } {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("method" in parsed)) {
    throw new Error(`not a JSON-RPC body: ${raw}`);
  }
  const method = parsed.method;
  return { method: String(method), params: "params" in parsed ? parsed.params : undefined };
}

interface Fake {
  readonly fetch: typeof fetch;
  readonly calls: Call[];
}

interface FakeScript {
  readonly rpc?: RpcScript;
  readonly etherscan?: EtherscanScript;
  /** Sourcify answers by path prefix. */
  readonly sourcify?: { lookup: Step; submit?: Step; job?: Step };
  readonly blockscout?: { lookup: Step; submit?: Step; status?: Step };
  /** Runs on every RPC call, before the answer. */
  readonly onRpc?: (method: string) => void;
}

function respond(step: Step, signal: AbortSignal | null | undefined): Promise<Response> {
  if (step === "network") {
    return Promise.reject(new TypeError("fetch failed"));
  }
  if (step === "hang") {
    return new Promise((_resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => {
        reject(signal.reason);
      });
    });
  }
  return Promise.resolve(
    new Response(JSON.stringify(step.body), {
      status: step.http ?? 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
}

function fake(script: FakeScript): Fake {
  const calls: Call[] = [];
  const fn: typeof fetch = async (target, init) => {
    const url = new URL(target instanceof Request ? target.url : String(target));
    const method = (
      target instanceof Request ? target.method : (init?.method ?? "GET")
    ).toUpperCase();
    const raw = target instanceof Request ? await target.clone().text() : bodyText(init?.body);
    const headers = [
      ...new Headers(target instanceof Request ? target.headers : init?.headers).entries(),
    ];
    const signal = target instanceof Request ? target.signal : init?.signal;
    const redirect = target instanceof Request ? target.redirect : init?.redirect;
    const base = { host: url.host, url: url.href, method, redirect, body: raw, headers };

    if (url.host === RPC_HOST || url.hostname === "localhost") {
      const { method: rpc, params } = rpcMethod(raw);
      calls.push({ ...base, what: rpc });
      script.onRpc?.(rpc);
      const entry = script.rpc?.[rpc];
      if (entry === undefined) {
        throw new Error(`no RPC answer scripted for ${rpc}`);
      }
      const step = typeof entry === "function" ? entry(params) : entry;
      if (step === "network" || step === "hang") {
        return await respond(step, signal);
      }
      const body =
        typeof step.body === "object" && step.body !== null && !("jsonrpc" in step.body)
          ? { jsonrpc: "2.0", id: rpcId(raw), ...step.body }
          : step.body;
      return await respond({ ...step, body }, signal);
    }
    if (
      url.host === "api.etherscan.io" ||
      url.host === "api.routescan.io" ||
      url.host === HANDLER_HOST
    ) {
      const form = new URLSearchParams(raw);
      const action = form.get("action") ?? url.searchParams.get("action") ?? "";
      calls.push({ ...base, what: url.host === "api.routescan.io" ? `rs:${action}` : action });
      if (
        action !== "getsourcecode" &&
        action !== "verifysourcecode" &&
        action !== "checkverifystatus" &&
        action !== "getcontractcreation"
      ) {
        throw new Error(`unexpected Etherscan action ${action}`);
      }
      const step = script.etherscan?.[action];
      if (step === undefined) {
        throw new Error(`no Etherscan answer scripted for ${action}`);
      }
      return await respond(step, signal);
    }
    if (url.host === "sourcify.dev") {
      const path = url.pathname.replace(/^\/server/u, "");
      const what = path.startsWith("/v2/contract/")
        ? "sourcify-lookup"
        : method === "POST"
          ? "sourcify-submit"
          : "sourcify-job";
      calls.push({ ...base, what });
      const step =
        what === "sourcify-lookup"
          ? script.sourcify?.lookup
          : what === "sourcify-submit"
            ? script.sourcify?.submit
            : script.sourcify?.job;
      if (step === undefined) {
        throw new Error(`no Sourcify answer scripted for ${what}`);
      }
      return await respond(step, signal);
    }
    if (url.host === "eth-sepolia.blockscout.com") {
      const form = new URLSearchParams(raw);
      const what = url.pathname.includes("/v2/smart-contracts/")
        ? "blockscout-lookup"
        : (form.get("action") ?? "");
      calls.push({ ...base, what });
      const step =
        what === "blockscout-lookup"
          ? script.blockscout?.lookup
          : what === "verifysourcecode"
            ? script.blockscout?.submit
            : script.blockscout?.status;
      if (step === undefined) {
        throw new Error(`no Blockscout answer scripted for ${what}`);
      }
      return await respond(step, signal);
    }
    throw new Error(`unexpected host ${url.host}`);
  };
  return { fetch: fn, calls };
}

// ---------------------------------------------------------------------------------------------
// Runs.

interface Run {
  readonly options: VerifyOptions;
  readonly calls: Call[];
  readonly events: VerifyEvent[];
  readonly logs: string[];
  readonly warns: { message: string; fields: LogFields | undefined }[];
  readonly infos: { message: string; fields: LogFields | undefined }[];
}

function setup(script: FakeScript, extra: Partial<VerifyOptions> = {}): Run {
  const f = fake(script);
  const events: VerifyEvent[] = [];
  const logs: string[] = [];
  const warns: { message: string; fields: LogFields | undefined }[] = [];
  const infos: { message: string; fields: LogFields | undefined }[] = [];
  const line =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      logs.push(`${level} ${message} ${JSON.stringify(fields ?? {})} ${inspect(fields)}`);
      if (level === "warn") {
        warns.push({ message, fields });
      } else if (level === "info") {
        infos.push({ message, fields });
      }
    };
  const logger: Logger = {
    debug: line("debug"),
    info: line("info"),
    warn: line("warn"),
    error: line("error"),
  };
  const options: VerifyOptions = {
    fetch: f.fetch,
    route: { backend: "etherscan-v2" },
    apiKeys: { "etherscan-v2": KEY },
    pollIntervalMs: 1_000,
    timeoutMs: 60_000,
    logger,
    onEvent: (event) => {
      events.push(event);
    },
    ...extra,
  };
  return { options, calls: f.calls, events, logs, warns, infos };
}

function makeInput(overrides: Partial<VerifyInput> = {}): VerifyInput {
  return {
    chainId: CHAIN_ID,
    address: GREETER.address,
    compiler: {
      kind: "solc",
      version: VERSION,
      input: {
        language: "Solidity",
        sources: { "src/ArgsGreeter.sol": { content: "contract ArgsGreeter {}" } },
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    },
    contractName: "src/ArgsGreeter.sol:ArgsGreeter",
    ...overrides,
  };
}

const greeterInput = (overrides: Partial<VerifyInput> = {}): VerifyInput =>
  makeInput({ creationTxHash: GREETER.txHash, creationBytecode: GREETER.bytecode, ...overrides });

const childInput = (overrides: Partial<VerifyInput> = {}): VerifyInput =>
  makeInput({
    address: CHILD.address,
    contractName: "src/ArgsChild.sol:ArgsChild",
    compiler: {
      kind: "solc",
      version: VERSION,
      input: {
        language: "Solidity",
        sources: { "src/ArgsChild.sol": { content: "contract ArgsChild {}" } },
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    },
    creationBytecode: CHILD.bytecode,
    ...overrides,
  });

const RPC_GREETER: RpcScript = {
  eth_chainId: { body: { result: CHAIN_HEX } },
  eth_getTransactionByHash: { body: { result: TX_GREETER } },
  eth_getTransactionReceipt: { body: { result: RECEIPT_GREETER } },
};

const RPC_FACTORY: RpcScript = {
  eth_chainId: { body: { result: CHAIN_HEX } },
  eth_getTransactionByHash: { body: { result: TX_FACTORY } },
  eth_getTransactionReceipt: { body: { result: RECEIPT_FACTORY } },
};

const ETHERSCAN_FLOW: EtherscanScript = {
  getsourcecode: LOOKUP_NONE,
  verifysourcecode: SUBMIT_OK,
  checkverifystatus: PASS,
};

function whats(run: Run): string[] {
  return run.calls.map((call) => call.what);
}

function rpcCalls(run: Run): Call[] {
  return run.calls.filter((call) => call.host === RPC_HOST || call.host.startsWith("localhost"));
}

function submitForm(run: Run): URLSearchParams {
  const submit = run.calls.find(
    (call) => call.what === "verifysourcecode" || call.what === "rs:verifysourcecode",
  );
  assert.ok(submit !== undefined, `no submit in ${whats(run).join(",")}`);
  return new URLSearchParams(submit.body);
}

function assertSubmittedArgs(run: Run, args: Hex): void {
  const form = submitForm(run);
  const bare = args.slice(2);
  assert.equal(form.get("constructorArguements"), bare, "constructorArguements");
  assert.equal(form.get("constructorArguments"), bare, "constructorArguments");
}

function assertSubmittedNoArgs(run: Run): void {
  const form = submitForm(run);
  assert.equal(form.has("constructorArguements"), false, "constructorArguements sent");
  assert.equal(form.has("constructorArguments"), false, "constructorArguments sent");
}

function assertNoCreationWarn(run: Run): void {
  assertSkipped(run, "no-creation-code", "warn");
}

/**
 * Decision 0032: the call went on without arguments, and one line at `level` names `reason` as a
 * field: `info` when no source was configured, `warn` otherwise.
 */
function assertSkipped(run: Run, reason: string, level: "info" | "warn"): void {
  const lines = level === "warn" ? run.warns : run.infos;
  const other = level === "warn" ? run.infos : run.warns;
  assert.ok(
    lines.some((line) => line.fields?.["reason"] === reason),
    `no ${level} line with reason ${reason} in ${JSON.stringify(lines)}`,
  );
  assert.ok(
    !other.some((line) => line.fields?.["reason"] === reason),
    `reason ${reason} also logged at another level`,
  );
}

function deepText(value: unknown): string {
  return inspect(value, { depth: Infinity, showHidden: true, getters: true });
}

/** No secret appears in any event, log line, result or error the caller sees. */
function assertNoSecretVisible(run: Run, outcome: unknown): void {
  const texts = [deepText(run.events), JSON.stringify(run.events), ...run.logs, deepText(outcome)];
  if (outcome instanceof ExplorerVerifyError) {
    texts.push(outcome.message, String(outcome.stack), JSON.stringify(outcome.toJSON()));
    texts.push(deepText(outcome.details), deepText(outcome.cause), outcome.hint);
  } else if (outcome instanceof Error) {
    texts.push(outcome.message, String(outcome.stack));
  } else {
    texts.push(JSON.stringify(outcome));
  }
  for (const secret of SECRETS) {
    for (const piece of texts) {
      assert.ok(
        !piece.toLowerCase().includes(secret.toLowerCase()),
        `secret ${secret.slice(0, 4)}… visible in: ${piece.slice(0, 400)}`,
      );
    }
  }
}

/** The Etherscan key never goes to the RPC host, and RPC requests do not follow redirects. */
function assertRpcRequestsSafe(run: Run): void {
  for (const call of rpcCalls(run)) {
    assert.equal(call.method, "POST", `${call.what} method`);
    assert.equal(call.redirect, "manual", `${call.what} redirect`);
    const all = `${call.url} ${call.body} ${JSON.stringify(call.headers)}`;
    assert.ok(!all.includes(KEY), `${call.what} carries the Etherscan key`);
  }
}

function assertNothingSubmitted(run: Run): void {
  assert.ok(
    !run.calls.some((call) => call.what === "verifysourcecode" || call.what === "sourcify-submit"),
    `a submit was sent: ${whats(run).join(",")}`,
  );
}

function reasonOf(error: ExplorerVerifyError): string | undefined {
  return error.details.code === "constructor-args-unavailable" ? error.details.reason : undefined;
}

function issuesOf(error: ExplorerVerifyError): string {
  return error.details.code === "invalid-input"
    ? JSON.stringify(error.details.issues)
    : error.message;
}

function withInput(tx: unknown, input: string): Record<string, unknown> {
  if (typeof tx !== "object" || tx === null) {
    throw new Error("fixture transaction is not an object");
  }
  return { ...Object.fromEntries(Object.entries(tx)), input };
}

function assertArgsError(error: ExplorerVerifyError, reason: string): void {
  assert.equal(
    error.code,
    "constructor-args-unavailable",
    `${error.code}: ${error.message} ${JSON.stringify(error.details)}`,
  );
  assert.equal(ERROR_EXIT_CODES[error.code], 2);
  assert.equal(error.retryable, false);
  assert.equal(reasonOf(error), reason);
  assert.match(error.hint, /constructorArgs/u, "hint names constructorArgs");
  assert.match(error.hint, /creationBytecode/u, "hint names creationBytecode");
}

// ---------------------------------------------------------------------------------------------

describe("blackbox #64: caller constructorArgs win (R-IN-3, verify.md Constructor arguments)", () => {
  it("sends the caller's arguments and makes no RPC or getcontractcreation request", async () => {
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    const result = await drive(verify(greeterInput({ constructorArgs: CHILD.args }), run.options));
    assert.equal(result.status, "verified");
    assert.equal(rpcCalls(run).length, 0, "RPC requests sent");
    assert.ok(!whats(run).includes("getcontractcreation"), "getcontractcreation sent");
    assertSubmittedArgs(run, CHILD.args);
    assertNoSecretVisible(run, result);
  });

  it("caller constructorArgs 0x (none) also skips derivation and sends no argument fields", async () => {
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    const result = await drive(verify(greeterInput({ constructorArgs: "0x" }), run.options));
    assert.equal(result.status, "verified");
    assert.equal(rpcCalls(run).length, 0);
    assert.ok(!whats(run).includes("getcontractcreation"));
    assertSubmittedNoArgs(run);
  });

  it("without creationBytecode nothing is derived, even with rpcUrl and creationTxHash", async () => {
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    await drive(verify(makeInput({ creationTxHash: GREETER.txHash }), run.options));
    assert.equal(rpcCalls(run).length, 0);
    assert.ok(!whats(run).includes("getcontractcreation"));
    assertSubmittedNoArgs(run);
  });

  it("an explorer that already has the contract returns before derivation (What it does, step 2-3)", async () => {
    const run = setup(
      { rpc: RPC_GREETER, etherscan: { ...ETHERSCAN_FLOW, getsourcecode: LOOKUP_EXACT } },
      { rpcUrl: RPC_URL },
    );
    const result = await drive(verify(greeterInput(), run.options));
    assert.equal(result.status, "already-verified");
    assert.equal(rpcCalls(run).length, 0);
    assert.deepEqual(whats(run), ["getsourcecode"]);
  });
});

describe("blackbox #64: derivation from rpcUrl, direct deployment (R-IN-3)", () => {
  it("derives the recorded Sepolia arguments and sends them in the submit", async () => {
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    const result = await drive(verify(greeterInput(), run.options));
    assert.equal(result.status, "verified");
    assertSubmittedArgs(run, GREETER.args);
    const rpc = rpcCalls(run).map((call) => call.what);
    assert.equal(rpc[0], "eth_chainId", "eth_chainId first");
    assert.ok(rpc.includes("eth_getTransactionByHash"));
    assert.ok(rpc.includes("eth_getTransactionReceipt"));
    assert.ok(!whats(run).includes("getcontractcreation"), "Etherscan asked though RPC answered");
    for (const call of rpcCalls(run)) {
      assert.equal(call.url, RPC_URL, "RPC request goes to rpcUrl unchanged");
    }
    assertRpcRequestsSafe(run);
    assertNoSecretVisible(run, result);
  });

  it("asks the RPC for the transaction named by creationTxHash", async () => {
    const seen: unknown[] = [];
    const run = setup(
      {
        rpc: {
          ...RPC_GREETER,
          eth_getTransactionByHash: (params) => {
            seen.push(params);
            return { body: { result: TX_GREETER } };
          },
        },
        etherscan: ETHERSCAN_FLOW,
      },
      { rpcUrl: RPC_URL },
    );
    await drive(verify(greeterInput(), run.options));
    assert.deepEqual(seen, [[GREETER.txHash]]);
  });

  it("accepts creationBytecode without 0x (TSDoc: with or without 0x)", async () => {
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    const bare = GREETER.bytecode.slice(2);
    // Hex is `0x${string}`; a value without the prefix arrives from JSON at run time.
    const input: unknown = { ...greeterInput(), creationBytecode: bare };
    const result = await drive(verifyLoose(input, run.options));
    assert.equal(field(result, "status"), "verified");
    assertSubmittedArgs(run, GREETER.args);
  });

  it("accepts upper-case hex in creationBytecode", async () => {
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    const upper = hex(`0x${GREETER.bytecode.slice(2).toUpperCase()}`);
    const result = await drive(verify(greeterInput({ creationBytecode: upper }), run.options));
    assert.equal(result.status, "verified");
    assertSubmittedArgs(run, GREETER.args);
  });

  it("returns no arguments for an empty remainder: no argument fields in the submit", async () => {
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    const result = await drive(
      verify(greeterInput({ creationBytecode: GREETER_INPUT }), run.options),
    );
    assert.equal(result.status, "verified");
    assertSubmittedNoArgs(run);
    assert.equal(run.warns.length, 0, `unexpected warn ${JSON.stringify(run.warns)}`);
  });

  it("works on http://localhost (rpcUrl rules)", async () => {
    const run = setup(
      { rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW },
      { rpcUrl: "http://localhost:8545" },
    );
    const result = await drive(verify(greeterInput(), run.options));
    assert.equal(result.status, "verified");
    assertSubmittedArgs(run, GREETER.args);
  });

  it("works on a Blockscout route and sends constructorArguments with 0x", async () => {
    const run = setup(
      {
        rpc: RPC_GREETER,
        blockscout: {
          lookup: { http: 404, body: { message: "Not found" } },
          submit: ok("0d7ba9133629d6732a3ef5a3f5f09c68dac4be656aeaee3f"),
          status: ok("Pass - Verified"),
        },
      },
      { rpcUrl: RPC_URL, route: { backend: "blockscout", apiUrl: BLOCKSCOUT_API }, apiKeys: {} },
    );
    // The fake's lookup never turns verified, so the call ends after the submit; only the submit
    // body matters here.
    const outcome = await drive(verify(greeterInput(), run.options)).catch(
      (error: unknown) => error,
    );
    const submit = run.calls.find((call) => call.what === "verifysourcecode");
    assert.ok(submit !== undefined);
    assert.equal(new URLSearchParams(submit.body).get("constructorArguments"), GREETER.args);
    assertNoSecretVisible(run, outcome);
  });
});

describe("blackbox #64: derivation from Etherscan getcontractcreation (R-IN-3)", () => {
  it("derives a factory child's arguments with no rpcUrl", async () => {
    const run = setup({
      etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: { body: CREATION_CHILD } },
    });
    const result = await drive(verify(childInput(), run.options));
    assert.equal(result.status, "verified");
    assertSubmittedArgs(run, CHILD.args);
    const creation = run.calls.find((call) => call.what === "getcontractcreation");
    assert.ok(creation !== undefined);
    const form = new URLSearchParams(creation.body);
    assert.equal(form.get("contractaddresses")?.toLowerCase(), CHILD.address);
    assert.ok(!creation.url.includes(KEY), "key in the getcontractcreation URL");
    assertNoSecretVisible(run, result);
  });

  it("uses route.apiKey as the bound key too", async () => {
    const run = setup(
      { etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: { body: CREATION_CHILD } } },
      { apiKeys: {}, route: { backend: "etherscan-v2", apiUrl: ETHERSCAN_API, apiKey: KEY } },
    );
    await drive(verify(childInput(), run.options));
    assertSubmittedArgs(run, CHILD.args);
  });

  it("factory in a constructor: RPC shows the factory, so Etherscan gives the child's code", async () => {
    const run = setup(
      {
        rpc: RPC_FACTORY,
        etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: { body: CREATION_CHILD } },
      },
      { rpcUrl: RPC_URL },
    );
    const result = await drive(verify(childInput({ creationTxHash: CHILD.txHash }), run.options));
    assert.equal(result.status, "verified");
    assertSubmittedArgs(run, CHILD.args);
    assert.ok(whats(run).includes("getcontractcreation"));
  });

  it("CREATE2 deployer (to is the deployer): Etherscan gives the child's code", async () => {
    const run = setup(
      {
        rpc: {
          eth_chainId: { body: { result: CHAIN_HEX } },
          eth_getTransactionByHash: { body: { result: TX_CREATE2 } },
          eth_getTransactionReceipt: { body: { result: null } },
        },
        etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: { body: CREATION_CREATE2 } },
      },
      { rpcUrl: RPC_URL },
    );
    const input = childInput({
      address: CREATE2.address,
      creationTxHash: CREATE2.txHash,
      creationBytecode: CREATE2.bytecode,
    });
    const result = await drive(verify(input, run.options));
    assert.equal(result.status, "verified");
    assertSubmittedArgs(run, CREATE2.args);
    // verify.md step 1: the receipt is read only when `to` is null.
    assert.ok(
      !rpcCalls(run).some((call) => call.what === "eth_getTransactionReceipt"),
      "receipt read although to is not null",
    );
  });

  it("direct deployment via getcontractcreation alone (recorded greeter answer)", async () => {
    const run = setup({
      etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: { body: CREATION_GREETER } },
    });
    await drive(verify(greeterInput(), run.options));
    assertSubmittedArgs(run, GREETER.args);
  });
});

describe("blackbox #64: library placeholders (R-IN-3)", () => {
  // Synthetic: replace one 20-byte span of the compiled bytecode with a placeholder. The creation
  // code keeps the original bytes there, standing for the linked address.
  const OFFSET = 2 + 2 * 40; // byte 40 of the bytecode
  const placeholder = `__$${"ab".repeat(17)}$__`;
  const linked = hex(
    `${GREETER.bytecode.slice(0, OFFSET)}${placeholder}${GREETER.bytecode.slice(OFFSET + 40)}`,
  );

  it("masks library placeholders when matching", async () => {
    assert.equal(linked.length, GREETER.bytecode.length);
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    const result = await drive(verify(greeterInput({ creationBytecode: linked }), run.options));
    assert.equal(result.status, "verified");
    assertSubmittedArgs(run, GREETER.args);
  });

  it("still compares the bytes around a placeholder: one changed byte is prefix-mismatch", async () => {
    const flipped =
      linked.slice(0, OFFSET - 2) + (linked.slice(OFFSET - 2, OFFSET) === "00" ? "01" : "00");
    const bad = hex(`${flipped}${linked.slice(OFFSET)}`);
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    const error = await errorOf(verify(greeterInput({ creationBytecode: bad }), run.options));
    assertArgsError(error, "prefix-mismatch");
    assertNothingSubmitted(run);
  });
});

describe("blackbox #64: soft fallbacks submit without arguments and warn (decision 0032)", () => {
  it("no source to ask: Etherscan route, injected fetch, no key, no rpcUrl", async () => {
    const run = setup({ etherscan: ETHERSCAN_FLOW }, { apiKeys: {}, handlerUrl: HANDLER_URL });
    const result = await drive(verify(greeterInput(), run.options));
    assert.equal(result.status, "verified");
    assert.ok(
      !whats(run).includes("getcontractcreation"),
      "getcontractcreation sent without a key",
    );
    assertSubmittedNoArgs(run);
    assertSkipped(run, "no-source", "info");
  });

  it("no source to ask: rpcUrl but no creationTxHash, and no key", async () => {
    const run = setup(
      { rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW },
      { apiKeys: {}, handlerUrl: HANDLER_URL, rpcUrl: RPC_URL },
    );
    await drive(verify(makeInput({ creationBytecode: GREETER.bytecode }), run.options));
    assert.ok(!rpcCalls(run).some((call) => call.what === "eth_getTransactionByHash"));
    assertSubmittedNoArgs(run);
    assertSkipped(run, "no-source", "info");
  });

  it("no source to ask on a Blockscout route without rpcUrl", async () => {
    const run = setup(
      {
        blockscout: {
          lookup: { http: 404, body: { message: "Not found" } },
          submit: ok("0d7ba9133629d6732a3ef5a3f5f09c68dac4be656aeaee3f"),
          status: ok("Pass - Verified"),
        },
      },
      { route: { backend: "blockscout", apiUrl: BLOCKSCOUT_API }, apiKeys: {} },
    );
    await drive(verify(greeterInput(), run.options)).catch(() => undefined);
    const submit = run.calls.find((call) => call.what === "verifysourcecode");
    assert.ok(submit !== undefined);
    assert.equal(new URLSearchParams(submit.body).has("constructorArguments"), false);
    assertSkipped(run, "no-source", "info");
  });

  const rpcFailures: [string, RpcScript][] = [
    [
      "RPC transaction request fails (network) after retries",
      { eth_chainId: { body: { result: CHAIN_HEX } }, eth_getTransactionByHash: "network" },
    ],
    [
      "RPC answers HTTP 500",
      {
        eth_chainId: { body: { result: CHAIN_HEX } },
        eth_getTransactionByHash: { http: 500, body: { error: "boom" } },
      },
    ],
    [
      "RPC answers a JSON-RPC error",
      {
        eth_chainId: { body: { result: CHAIN_HEX } },
        eth_getTransactionByHash: {
          body: { error: { code: -32000, message: "header not found" } },
        },
      },
    ],
    [
      "transaction not found",
      {
        eth_chainId: { body: { result: CHAIN_HEX } },
        eth_getTransactionByHash: { body: { result: null } },
      },
    ],
    [
      "receipt not found",
      {
        eth_chainId: { body: { result: CHAIN_HEX } },
        eth_getTransactionByHash: { body: { result: TX_GREETER } },
        eth_getTransactionReceipt: { body: { result: null } },
      },
    ],
    [
      "transaction input not hex",
      {
        eth_chainId: { body: { result: CHAIN_HEX } },
        eth_getTransactionByHash: {
          body: { result: withInput(TX_GREETER, "not-hex-at-all") },
        },
        eth_getTransactionReceipt: { body: { result: RECEIPT_GREETER } },
      },
    ],
    ["eth_chainId request fails", { eth_chainId: "network" }],
  ];

  for (const [name, rpc] of rpcFailures) {
    it(`${name}, no key: warns and submits without arguments`, async () => {
      const run = setup(
        { rpc, etherscan: ETHERSCAN_FLOW },
        { apiKeys: {}, handlerUrl: HANDLER_URL, rpcUrl: RPC_URL },
      );
      const result = await drive(verify(greeterInput(), run.options));
      assert.equal(result.status, "verified");
      assertSubmittedNoArgs(run);
      assertNoCreationWarn(run);
      assertNoSecretVisible(run, result);
    });

    it(`${name}, with a key: moves on to getcontractcreation`, async () => {
      const run = setup(
        { rpc, etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: { body: CREATION_GREETER } } },
        { rpcUrl: RPC_URL },
      );
      const result = await drive(verify(greeterInput(), run.options));
      assert.equal(result.status, "verified");
      assert.ok(whats(run).includes("getcontractcreation"));
      assertSubmittedArgs(run, GREETER.args);
      assertNoSecretVisible(run, result);
    });
  }

  const explorerFailures: [string, Step][] = [
    ["getcontractcreation network failure", "network"],
    ["getcontractcreation rate limited", notok("Max calls per sec rate limit reached (3/sec)")],
    ["getcontractcreation unexpected response", { body: { surprise: true } }],
    ["getcontractcreation no record", { body: CREATION_NONE }],
  ];

  for (const [name, step] of explorerFailures) {
    it(`${name}, no rpcUrl: warns and submits without arguments`, async () => {
      const run = setup({ etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: step } });
      const result = await drive(verify(greeterInput(), run.options));
      assert.equal(result.status, "verified");
      assertSubmittedNoArgs(run);
      assertNoCreationWarn(run);
      assertNoSecretVisible(run, result);
    });
  }

  it("factory transaction and getcontractcreation network failure: unavailable, not an error", async () => {
    const run = setup(
      { rpc: RPC_FACTORY, etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: "network" } },
      { rpcUrl: RPC_URL },
    );
    const result = await drive(verify(childInput({ creationTxHash: CHILD.txHash }), run.options));
    assert.equal(result.status, "verified");
    assertSubmittedNoArgs(run);
    assertSkipped(run, "factory-deployment", "warn");
  });

  it("transaction not found and getcontractcreation no record: unavailable", async () => {
    const run = setup(
      {
        rpc: {
          eth_chainId: { body: { result: CHAIN_HEX } },
          eth_getTransactionByHash: { body: { result: null } },
        },
        etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: { body: CREATION_NONE } },
      },
      { rpcUrl: RPC_URL },
    );
    const result = await drive(verify(greeterInput(), run.options));
    assert.equal(result.status, "verified");
    assertSubmittedNoArgs(run);
    assertNoCreationWarn(run);
  });
});

describe("blackbox #64: hard errors throw constructor-args-unavailable (decision 0032)", () => {
  it("prefix-mismatch when one source comment differs, with the deployed-build hint", async () => {
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    const error = await errorOf(
      verify(greeterInput({ creationBytecode: EDITED_BYTECODE }), run.options),
    );
    assertArgsError(error, "prefix-mismatch");
    // Error page: the input differs from the deployed build; the hint says to check it.
    assert.match(error.message, /differs from the deployed build/u);
    assert.match(error.hint, /deployed build/u);
    assertNothingSubmitted(run);
    assertNoSecretVisible(run, error);
    assert.ok(!run.events.some((event) => event.type === "verify.result"), "verify.result emitted");
  });

  it("prefix-mismatch from the getcontractcreation source too", async () => {
    const run = setup({
      etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: { body: CREATION_GREETER } },
    });
    const error = await errorOf(
      verify(greeterInput({ creationBytecode: EDITED_BYTECODE }), run.options),
    );
    assertArgsError(error, "prefix-mismatch");
    assertNothingSubmitted(run);
  });

  it("prefix-mismatch when creationBytecode is longer than the creation code", async () => {
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    const longer = hex(`${GREETER_INPUT}00`);
    const error = await errorOf(verify(greeterInput({ creationBytecode: longer }), run.options));
    assertArgsError(error, "prefix-mismatch");
  });

  it("bad-length for a remainder that is not whole words", async () => {
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    // creationBytecode is the creation code minus 31 bytes: the remainder is 31 bytes.
    const short = hex(GREETER_INPUT.slice(0, GREETER_INPUT.length - 62));
    const error = await errorOf(verify(greeterInput({ creationBytecode: short }), run.options));
    assertArgsError(error, "bad-length");
    assertNothingSubmitted(run);
    assertNoSecretVisible(run, error);
  });

  it("bad-length for a remainder of 33 bytes", async () => {
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    const short = hex(GREETER.bytecode.slice(0, GREETER.bytecode.length - 2));
    const error = await errorOf(verify(greeterInput({ creationBytecode: short }), run.options));
    assertArgsError(error, "bad-length");
  });

  it("factory-deployment when the factory transaction is known and Etherscan has no record: warns and submits without arguments", async () => {
    const run = setup(
      {
        rpc: RPC_FACTORY,
        etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: { body: CREATION_NONE } },
      },
      { rpcUrl: RPC_URL },
    );
    const result = await drive(verify(childInput({ creationTxHash: CHILD.txHash }), run.options));
    assert.equal(result.status, "verified");
    assertSubmittedNoArgs(run);
    assertSkipped(run, "factory-deployment", "warn");
    assertNoSecretVisible(run, result);
  });

  it("factory-deployment when the factory transaction is known and no key is bound: warns and submits without arguments", async () => {
    const run = setup(
      { rpc: RPC_FACTORY, etherscan: ETHERSCAN_FLOW },
      { rpcUrl: RPC_URL, apiKeys: {}, handlerUrl: HANDLER_URL },
    );
    const result = await drive(verify(childInput({ creationTxHash: CHILD.txHash }), run.options));
    assert.equal(result.status, "verified");
    assert.ok(!whats(run).includes("getcontractcreation"));
    assertSubmittedNoArgs(run);
    assertSkipped(run, "factory-deployment", "warn");
    const warn = run.warns.find((line) => line.fields?.["reason"] === "factory-deployment");
    assert.match(warn?.message ?? "", /names another transaction/u);
  });

  it("CREATE2 deployer transaction: derives from the init code after the salt, without Etherscan", async () => {
    const run = setup(
      {
        rpc: {
          eth_chainId: { body: { result: CHAIN_HEX } },
          eth_getTransactionByHash: { body: { result: TX_CREATE2 } },
          eth_getTransactionReceipt: { body: { result: null } },
        },
        etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: { body: CREATION_NONE } },
      },
      { rpcUrl: RPC_URL },
    );
    const input = childInput({
      address: CREATE2.address,
      creationTxHash: CREATE2.txHash,
      creationBytecode: CREATE2.bytecode,
    });
    const result = await drive(verify(input, run.options));
    assert.equal(result.status, "verified");
    assertSubmittedArgs(run, CREATE2.args);
    assert.ok(!whats(run).includes("getcontractcreation"));
    assert.ok(!whats(run).includes("eth_getTransactionReceipt"));
  });

  it("factory-deployment on a Blockscout route (no explorer source): warns and submits without arguments", async () => {
    const run = setup(
      {
        rpc: RPC_FACTORY,
        blockscout: {
          lookup: { http: 404, body: { message: "Not found" } },
          submit: ok("0d7ba9133629d6732a3ef5a3f5f09c68dac4be656aeaee3f"),
          status: ok("Pass - Verified"),
        },
      },
      { rpcUrl: RPC_URL, route: { backend: "blockscout", apiUrl: BLOCKSCOUT_API }, apiKeys: {} },
    );
    await drive(verify(childInput({ creationTxHash: CHILD.txHash }), run.options)).catch(
      () => undefined,
    );
    const submit = run.calls.find((call) => call.what === "verifysourcecode");
    assert.ok(submit !== undefined, whats(run).join(","));
    assert.equal(new URLSearchParams(submit.body).has("constructorArguments"), false);
    assertSkipped(run, "factory-deployment", "warn");
  });

  it("the error serialises with details.reason and no secret (toJSON)", async () => {
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    const error = await errorOf(
      verify(greeterInput({ creationBytecode: EDITED_BYTECODE }), run.options),
    );
    const json = JSON.stringify(error.toJSON());
    assert.match(json, /constructor-args-unavailable/u);
    // errors/index.md: toJSON prints code, message, hint, docsUrl, retryable (no details).
    assert.equal(reasonOf(error), "prefix-mismatch");
    assertNoSecretVisible(run, error);
  });
});

describe("blackbox #64: errors that propagate (decision 0032)", () => {
  it("rpcUrl on another chain throws invalid-input naming rpcUrl, before any submit", async () => {
    const run = setup(
      {
        rpc: { ...RPC_GREETER, eth_chainId: { body: { result: "0x1" } } },
        etherscan: ETHERSCAN_FLOW,
      },
      { rpcUrl: RPC_URL },
    );
    const error = await errorOf(verify(greeterInput(), run.options));
    assert.equal(error.code, "invalid-input");
    const issues = issuesOf(error);
    assert.match(issues, /rpcUrl/u);
    assertNothingSubmitted(run);
    assert.ok(!rpcCalls(run).some((call) => call.what === "eth_getTransactionByHash"));
    assertNoSecretVisible(run, error);
  });

  it("an explorer key error on getcontractcreation propagates (api-key-rejected)", async () => {
    const run = setup({
      etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: notok("Invalid API Key (#err2)|x") },
    });
    const error = await errorOf(verify(greeterInput(), run.options));
    assert.equal(error.code, "api-key-rejected");
    assertNothingSubmitted(run);
    assertNoSecretVisible(run, error);
  });

  it("timeout while the RPC hangs throws timeout, nothing submitted", async () => {
    const run = setup(
      { rpc: { eth_chainId: "hang" }, etherscan: ETHERSCAN_FLOW },
      { rpcUrl: RPC_URL, timeoutMs: 5_000 },
    );
    const error = await errorOf(verify(greeterInput(), run.options));
    assert.equal(error.code, "timeout");
    assertNothingSubmitted(run);
    assertNoSecretVisible(run, error);
  });

  it("timeout while getcontractcreation hangs throws timeout", async () => {
    const run = setup(
      { etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: "hang" } },
      { timeoutMs: 5_000 },
    );
    const error = await errorOf(verify(greeterInput(), run.options));
    assert.equal(error.code, "timeout");
    assertNothingSubmitted(run);
  });

  it("an abort during derivation rejects with signal.reason unchanged", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const run = setup(
      {
        rpc: { ...RPC_GREETER, eth_getTransactionByHash: "hang" },
        etherscan: ETHERSCAN_FLOW,
        onRpc: (method) => {
          if (method === "eth_getTransactionByHash") {
            queueMicrotask(() => {
              controller.abort(reason);
            });
          }
        },
      },
      { rpcUrl: RPC_URL, signal: controller.signal },
    );
    await assert.rejects(drive(verify(greeterInput(), run.options)), (error) => error === reason);
    assertNothingSubmitted(run);
  });
});

describe("blackbox #64: Sourcify routes never derive (verify.md Constructor arguments)", () => {
  it("sends no RPC or Etherscan request and no constructor arguments", async () => {
    const run = setup(
      {
        rpc: RPC_GREETER,
        sourcify: {
          lookup: {
            http: 404,
            body: {
              match: null,
              creationMatch: null,
              runtimeMatch: null,
              chainId: String(CHAIN_ID),
              address: GREETER.address,
            },
          },
          submit: { http: 202, body: { verificationId: "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718" } },
          job: {
            body: {
              isJobCompleted: true,
              verificationId: "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718",
              contract: {
                match: "exact_match",
                creationMatch: "exact_match",
                runtimeMatch: "exact_match",
                chainId: String(CHAIN_ID),
                address: GREETER.address,
              },
            },
          },
        },
      },
      { rpcUrl: RPC_URL, route: { backend: "sourcify" } },
    );
    const outcome = await drive(verify(greeterInput(), run.options)).catch(
      (error: unknown) => error,
    );
    assert.equal(rpcCalls(run).length, 0, "RPC asked on a Sourcify route");
    assert.ok(!whats(run).includes("getcontractcreation"));
    const submit = run.calls.find((call) => call.what === "sourcify-submit");
    assert.ok(submit !== undefined, `no Sourcify submit: ${deepText(outcome).slice(0, 300)}`);
    assert.ok(!/constructor/iu.test(submit.body), "constructor arguments sent to Sourcify");
    assert.ok(
      !submit.body.includes(GREETER.bytecode.slice(2, 200)),
      "creationBytecode sent to Sourcify",
    );
    assertNoSecretVisible(run, outcome);
  });

  it("does not send creationBytecode to Etherscan either (TSDoc: never sent)", async () => {
    const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    await drive(verify(greeterInput(), run.options));
    const explorer = run.calls.filter((call) => call.host === "api.etherscan.io");
    for (const call of explorer) {
      assert.ok(
        !call.body.includes(GREETER.bytecode.slice(2, 200)),
        `${call.what} carries creationBytecode`,
      );
    }
  });
});

describe("blackbox #64: rpcUrl validation (follows route.apiUrl rules)", () => {
  const bad: [string, string][] = [
    ["http on a public host", `http://${RPC_HOST}/v3/${RPC_SECRET}`],
    ["user name and password", `https://user:${RPC_SECRET}@${RPC_HOST}/v3/x`],
    ["user name only", `https://${RPC_SECRET}@${RPC_HOST}/v3/x`],
    ["fragment", `https://${RPC_HOST}/v3/${RPC_SECRET}#frag`],
    ["relative URL", `/v3/${RPC_SECRET}`],
    ["ftp scheme", `ftp://${RPC_HOST}/${RPC_SECRET}`],
    ["not a URL", `not a url ${RPC_SECRET}`],
  ];
  for (const [name, url] of bad) {
    it(`rejects ${name} with invalid-input before any request, secret not shown`, async () => {
      const run = setup({ rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW }, { rpcUrl: url });
      const error = await errorOf(verify(greeterInput(), run.options));
      assert.equal(error.code, "invalid-input");
      assert.match(issuesOf(error), /rpcUrl/u);
      assert.equal(run.calls.length, 0, `requests sent: ${whats(run).join(",")}`);
      assertNoSecretVisible(run, error);
    });
  }

  it("rejects a non-string rpcUrl with invalid-input", async () => {
    const run = setup({ etherscan: ETHERSCAN_FLOW });
    const options: unknown = { ...run.options, rpcUrl: 42 };
    const error = await errorOfLoose(verifyLoose(greeterInput(), options));
    assert.equal(error.code, "invalid-input");
    assert.equal(run.calls.length, 0);
  });

  for (const local of ["http://127.0.0.1:8545", "http://[::1]:8545"]) {
    it(`accepts ${local}`, async () => {
      const run = setup({ etherscan: ETHERSCAN_FLOW }, { rpcUrl: local });
      // The fake does not serve these hosts; the derivation falls back. Only validation matters.
      const outcome = await drive(verify(greeterInput(), run.options)).catch(
        (error: unknown) => error,
      );
      if (outcome instanceof ExplorerVerifyError) {
        assert.notEqual(outcome.code, "invalid-input", outcome.message);
      }
    });
  }

  it("rejects an rpcUrl validated even when it is never used (Sourcify route)", async () => {
    const run = setup(
      {},
      { rpcUrl: `http://${RPC_HOST}/v3/${RPC_SECRET}`, route: { backend: "sourcify" } },
    );
    const error = await errorOf(verify(greeterInput(), run.options));
    assert.equal(error.code, "invalid-input");
    assert.equal(run.calls.length, 0);
  });

  it("rejects malformed creationBytecode with invalid-input (validateInput checks its format)", async () => {
    const run = setup({ etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    const error = await errorOf(verify(greeterInput({ creationBytecode: "0xzz12" }), run.options));
    assert.equal(error.code, "invalid-input");
    assert.match(issuesOf(error), /creationBytecode/u);
    assert.equal(run.calls.length, 0);
  });

  it("rejects creationBytecode of an odd number of hex digits", async () => {
    const run = setup({ etherscan: ETHERSCAN_FLOW }, { rpcUrl: RPC_URL });
    const error = await errorOf(verify(greeterInput({ creationBytecode: "0x123" }), run.options));
    assert.equal(error.code, "invalid-input");
    assert.equal(run.calls.length, 0);
  });
});

describe("blackbox #64: no secret part of rpcUrl or key is visible (R-SEC-1)", () => {
  it("an RPC error that echoes the URL path and query does not leak into the warn line", async () => {
    const echo = `upstream ${RPC_URL} and ${RPC_URL_QUERY} failed for ${RPC_SECRET}/${RPC_QUERY_SECRET}`;
    const run = setup(
      {
        rpc: {
          eth_chainId: { body: { result: CHAIN_HEX } },
          eth_getTransactionByHash: { body: { error: { code: -32000, message: echo } } },
        },
        etherscan: ETHERSCAN_FLOW,
      },
      { rpcUrl: RPC_URL_QUERY, apiKeys: {}, handlerUrl: HANDLER_URL },
    );
    const result = await drive(verify(greeterInput(), run.options));
    assertNoCreationWarn(run);
    assertNoSecretVisible(run, result);
  });

  it("an RPC 500 whose body echoes the path secret does not leak (path rpcUrl)", async () => {
    const run = setup(
      {
        rpc: {
          eth_chainId: { body: { result: CHAIN_HEX } },
          eth_getTransactionByHash: { http: 500, body: { message: `bad key ${RPC_SECRET}` } },
        },
        etherscan: ETHERSCAN_FLOW,
      },
      { rpcUrl: RPC_URL, apiKeys: {}, handlerUrl: HANDLER_URL },
    );
    const result = await drive(verify(greeterInput(), run.options));
    assertNoSecretVisible(run, result);
  });

  it("a chain-mismatch error with a query-secret rpcUrl does not leak it", async () => {
    const run = setup(
      { rpc: { eth_chainId: { body: { result: "0x1" } } }, etherscan: ETHERSCAN_FLOW },
      { rpcUrl: RPC_URL_QUERY },
    );
    const error = await errorOf(verify(greeterInput(), run.options));
    assert.equal(error.code, "invalid-input");
    assertNoSecretVisible(run, error);
  });

  it("a timeout during RPC derivation does not leak the path secret", async () => {
    const run = setup(
      {
        rpc: { eth_chainId: { body: { result: CHAIN_HEX } }, eth_getTransactionByHash: "hang" },
        etherscan: ETHERSCAN_FLOW,
      },
      { rpcUrl: RPC_URL, timeoutMs: 5_000 },
    );
    const error = await errorOf(verify(greeterInput(), run.options));
    assertNoSecretVisible(run, error);
  });

  it("a network failure whose message holds the URL does not leak", async () => {
    const f = fake({ etherscan: ETHERSCAN_FLOW });
    const leaky: typeof fetch = async (target, init) => {
      const url = String(target instanceof Request ? target.url : target);
      if (url.includes(RPC_HOST)) {
        throw new TypeError(`fetch failed: ${url}`);
      }
      return await f.fetch(target, init);
    };
    const run = setup(
      { etherscan: ETHERSCAN_FLOW },
      { rpcUrl: RPC_URL, apiKeys: {}, handlerUrl: HANDLER_URL, fetch: leaky },
    );
    const result = await drive(verify(greeterInput(), run.options));
    assertNoCreationWarn(run);
    assertNoSecretVisible(run, result);
  });
});

describe("blackbox #64: buildVerifyInput fills creationBytecode (R-IN-7)", () => {
  const FORMATS = new URL("../fixtures/build-formats/", import.meta.url);
  const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, FORMATS), "utf8"));

  it("from a Foundry build-info and artifact: the artifact's bytecode.object", () => {
    const artifact = read("foundry-1.8.1/Greeter.json");
    const built = buildVerifyInput([read("foundry-1.8.1/build-info.json"), artifact], {
      contract: "src/Greeter.sol:Greeter",
    });
    assert.equal(
      built.creationBytecode?.toLowerCase(),
      text(artifact, "bytecode", "object").toLowerCase(),
    );
  });

  it("from a Hardhat 2 build-info and artifact: the artifact's bytecode", () => {
    const artifact = read("hardhat-2.29.1/Greeter.json");
    const built = buildVerifyInput([read("hardhat-2.29.1/build-info.json"), artifact], {
      contract: "contracts/Greeter.sol:Greeter",
    });
    assert.equal(built.creationBytecode?.toLowerCase(), text(artifact, "bytecode").toLowerCase());
  });

  it("leaves creationBytecode out when the documents do not hold it", () => {
    const built = buildVerifyInput([read("foundry-1.8.1/build-info.json")], {
      contract: "src/Greeter.sol:Greeter",
    });
    assert.equal(built.creationBytecode, undefined);
  });

  it("a built input derives the arguments end to end", async () => {
    const artifact = read("foundry-1.8.1/Greeter.json");
    const built = buildVerifyInput([read("foundry-1.8.1/build-info.json"), artifact], {
      contract: "src/Greeter.sol:Greeter",
    });
    const bytecode = text(artifact, "bytecode", "object");
    const args = GREETER.args;
    const tx = withInput(TX_GREETER, `${bytecode}${args.slice(2)}`);
    const run = setup(
      {
        rpc: { ...RPC_GREETER, eth_getTransactionByHash: { body: { result: tx } } },
        etherscan: ETHERSCAN_FLOW,
      },
      { rpcUrl: RPC_URL },
    );
    const input: VerifyInput = {
      chainId: CHAIN_ID,
      address: GREETER.address,
      creationTxHash: GREETER.txHash,
      ...built,
    };
    const result = await drive(verify(input, run.options));
    assert.equal(result.status, "verified");
    assertSubmittedArgs(run, args);
  });
});

describe("blackbox #64: more edges", () => {
  const ROUTESCAN = "https://api.routescan.io/v2/network/testnet/evm/11155111/etherscan/api";

  it("Routescan route derives from rpcUrl and sends the arguments", async () => {
    const run = setup(
      { rpc: RPC_GREETER, etherscan: ETHERSCAN_FLOW },
      { rpcUrl: RPC_URL, route: { backend: "routescan", apiUrl: ROUTESCAN }, apiKeys: {} },
    );
    await drive(verify(greeterInput(), run.options)).catch(() => undefined);
    assertSubmittedArgs(run, GREETER.args);
    assert.ok(!whats(run).some((what) => what.endsWith("getcontractcreation")));
  });

  it("Routescan route without rpcUrl never asks getcontractcreation, even with an Etherscan key", async () => {
    const run = setup(
      { etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: { body: CREATION_GREETER } } },
      { route: { backend: "routescan", apiUrl: ROUTESCAN }, apiKeys: { "etherscan-v2": KEY } },
    );
    await drive(verify(greeterInput(), run.options)).catch(() => undefined);
    assert.ok(
      !whats(run).some((what) => what.endsWith("getcontractcreation")),
      whats(run).join(","),
    );
    assertSubmittedNoArgs(run);
    assertSkipped(run, "no-source", "info");
  });

  it("a missing-key answer on getcontractcreation propagates", async () => {
    const run = setup({
      etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: notok("Missing/Invalid API Key") },
    });
    const error = await errorOf(verify(greeterInput(), run.options));
    assert.equal(error.code, "missing-api-key");
    assertNothingSubmitted(run);
  });

  it("a daily-limit answer on getcontractcreation (quota-exceeded)", async () => {
    const run = setup({
      etherscan: {
        ...ETHERSCAN_FLOW,
        getcontractcreation: notok(
          "Max daily rate limit reached. 100000 (100%) of 100000 day/limit",
        ),
      },
    });
    const outcome = await drive(verify(greeterInput(), run.options)).catch(
      (error: unknown) => error,
    );
    // Decision 0032 lists "a key error from the explorer" as propagating; quota-exceeded is an
    // exit-3 key error in verify.md's table.
    assert.ok(outcome instanceof ExplorerVerifyError, `got ${deepText(outcome).slice(0, 200)}`);
    assert.equal(outcome.code, "quota-exceeded");
  });

  it("eth_chainId with a non-hex result: no usable answer, submits without arguments", async () => {
    const run = setup(
      {
        rpc: { ...RPC_GREETER, eth_chainId: { body: { result: "sepolia" } } },
        etherscan: ETHERSCAN_FLOW,
      },
      { rpcUrl: RPC_URL, apiKeys: {}, handlerUrl: HANDLER_URL },
    );
    const outcome = await drive(verify(greeterInput(), run.options)).catch(
      (error: unknown) => error,
    );
    // Decision 0032: "a JSON-RPC endpoint that gives no usable answer" counts as unavailable;
    // invalid-input naming rpcUrl is listed only for an endpoint that "serves another chain".
    assert.ok(
      !(outcome instanceof Error),
      `threw ${outcome instanceof ExplorerVerifyError ? `${outcome.code} ${JSON.stringify(outcome.details)}` : deepText(outcome).slice(0, 300)}`,
    );
    assertSubmittedNoArgs(run);
    assertNoCreationWarn(run);
  });

  it("eth_chainId JSON-RPC error: no usable answer, submits without arguments", async () => {
    const run = setup(
      {
        rpc: {
          ...RPC_GREETER,
          eth_chainId: { body: { error: { code: -32601, message: "nope" } } },
        },
        etherscan: ETHERSCAN_FLOW,
      },
      { rpcUrl: RPC_URL, apiKeys: {}, handlerUrl: HANDLER_URL },
    );
    const outcome = await drive(verify(greeterInput(), run.options)).catch(
      (error: unknown) => error,
    );
    assert.ok(!(outcome instanceof Error), `threw ${deepText(outcome).slice(0, 300)}`);
    assertSubmittedNoArgs(run);
  });

  it("an RPC redirect is not followed (no request to the redirect target)", async () => {
    const run = setup(
      {
        rpc: { ...RPC_GREETER, eth_chainId: { http: 302, body: {} } },
        etherscan: ETHERSCAN_FLOW,
      },
      { rpcUrl: RPC_URL, apiKeys: {}, handlerUrl: HANDLER_URL },
    );
    const outcome = await drive(verify(greeterInput(), run.options)).catch(
      (error: unknown) => error,
    );
    assert.ok(run.calls.every((call) => call.host !== "evil.example"));
    assertNoSecretVisible(run, outcome);
  });

  it("the log line for no-source carries reason as a field, at info", async () => {
    const run = setup({ etherscan: ETHERSCAN_FLOW }, { apiKeys: {}, handlerUrl: HANDLER_URL });
    await drive(verify(greeterInput(), run.options));
    assertSkipped(run, "no-source", "info");
  });

  it("the warn line for no-creation-code carries reason as a field", async () => {
    const run = setup({
      etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: { body: CREATION_NONE } },
    });
    await drive(verify(greeterInput(), run.options));
    assert.ok(
      run.warns.some((warn) => warn.fields?.["reason"] === "no-creation-code"),
      JSON.stringify(run.warns),
    );
  });

  it("getcontractcreation answers for another address: not used to derive", async () => {
    const run = setup({
      etherscan: { ...ETHERSCAN_FLOW, getcontractcreation: { body: CREATION_CHILD } },
    });
    // The greeter input, but Etherscan answers with the child's record.
    const outcome = await drive(verify(greeterInput(), run.options)).catch(
      (error: unknown) => error,
    );
    const form = run.calls.find((call) => call.what === "verifysourcecode");
    if (form !== undefined) {
      assert.notEqual(
        new URLSearchParams(form.body).get("constructorArguements"),
        CHILD.args.slice(2),
      );
    }
    // Undocumented case: record the outcome. A record for another contract is an unexpected
    // response, which decision 0032 counts as unavailable (warn, submit without arguments).
    assert.ok(
      !(outcome instanceof Error),
      `outcome ${outcome instanceof ExplorerVerifyError ? `${outcome.code} ${JSON.stringify(outcome.details)}` : String(outcome)}`,
    );
  });
});
